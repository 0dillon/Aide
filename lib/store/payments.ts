import { createReservedAccount, getReservedAccount, getReservedAccountTransactions } from "../monnify";
import { getAccount } from "./accounts";
import { wallets, withdrawals, state, type PendingWithdrawal, type Wallet, type WithdrawalRecord } from "./state";

// Per-account Monnify wallets. Every Aide account gets its own dedicated
// reserved NUBAN (Monnify's per-customer virtual account), so balances are
// isolated and real: available = confirmed inbound transfers − withdrawals.
//
// Provisioning flow (per Monnify's guidance: create at customer signup):
//  - signup / voice create_account fire provisionWallet() in the background,
//    so account creation never blocks on the Monnify API;
//  - every balance/receive path goes through ensureWallet(), the lazy,
//    self-healing fallback that provisions on first use if signup-time
//    provisioning failed or predates this feature.

const CONFIRM_WORDS = ["mango", "sunrise", "guitar", "river", "orange", "candle", "harvest", "compass"];
const PENDING_TTL_MS = 5 * 60 * 1000;
const BALANCE_TTL_MS = 20_000;

function makeConfirmPhrase(): string {
  return CONFIRM_WORDS[Math.floor(Math.random() * CONFIRM_WORDS.length)];
}

// Loose match: the user may say "mango" or "the word is mango". ASR is imperfect,
// so we check the confirm word appears among the spoken tokens.
function phraseMatches(spoken: string, phrase: string): boolean {
  return spoken
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .includes(phrase);
}

// The demo worker keeps the reference that predates per-account wallets, so
// its already-funded real NUBAN stays attached. Everyone else gets aide-<id>.
export function walletReferenceFor(accountId: string): string {
  return accountId === "demo-worker" ? "aide-demo-worker" : `aide-${accountId}`;
}

export function accountIdFromWalletReference(reference: string): string | undefined {
  if (reference === "aide-demo-worker") return "demo-worker";
  return reference.startsWith("aide-") ? reference.slice("aide-".length) : undefined;
}

export function getWallet(accountId: string): Wallet {
  let w = wallets.get(accountId);
  if (!w) {
    w = {
      accountId,
      accountReference: walletReferenceFor(accountId),
      status: "unprovisioned",
      knownTxRefs: new Set(),
      txSeeded: false,
    };
    wallets.set(accountId, w);
  }
  return w;
}

export function listActiveWallets(): Wallet[] {
  return [...wallets.values()].filter((w) => w.status === "active");
}

// One in-flight provisioning per account — signup's background call and a
// concurrent balance request must not both hit Monnify's create endpoint.
const inFlight = new Map<string, Promise<Wallet>>();

export function ensureWallet(accountId: string): Promise<Wallet> {
  const wallet = getWallet(accountId);
  if (wallet.status === "active") return Promise.resolve(wallet);
  const running = inFlight.get(accountId);
  if (running) return running;

  const p = (async () => {
    const acc = getAccount(accountId);
    // Reuse the NUBAN if this reference was ever reserved before (restarts,
    // failed retries); only mint a new reserved account when none exists.
    let reserved;
    try {
      reserved = await getReservedAccount(wallet.accountReference);
    } catch {
      reserved = await createReservedAccount({
        accountReference: wallet.accountReference,
        accountName: acc.name,
        customerName: acc.name,
        // customerEmail must be unique per reserved account on Monnify.
        customerEmail: acc.email || `${wallet.accountReference}@aide.test`,
      });
    }
    wallet.accountNumber = reserved.accounts[0].accountNumber;
    wallet.bankName = reserved.accounts[0].bankName;
    wallet.status = "active";
    wallet.lastError = undefined;
    return wallet;
  })();

  inFlight.set(
    accountId,
    p.catch((e) => {
      wallet.status = "failed";
      wallet.lastError = (e as Error).message;
      throw e;
    }).finally(() => inFlight.delete(accountId)),
  );
  return inFlight.get(accountId)!;
}

// Fire-and-forget provisioning for signup paths. Failures are recorded on the
// wallet and retried by ensureWallet() on first real use.
export function provisionWalletInBackground(accountId: string): void {
  ensureWallet(accountId).catch((e) => {
    console.warn(`Wallet provisioning for ${accountId} failed (will retry on first use):`, (e as Error).message);
  });
}

// --- Balance ---

export function cacheWalletBalance(accountId: string, inboundTotal: number): void {
  const w = getWallet(accountId);
  w.balanceCache = { value: availableFrom(accountId, inboundTotal), at: Date.now() };
}

function availableFrom(accountId: string, inboundTotal: number): number {
  const withdrawn = withdrawals
    .filter((r) => r.accountId === accountId && r.status !== "FAILED")
    .reduce((s, r) => s + r.amount, 0);
  return Math.max(0, inboundTotal - withdrawn);
}

// Real, isolated balance: confirmed inbound transfers to THIS wallet's NUBAN
// minus this wallet's withdrawals. Cached briefly — the greeting, payments
// page, and agent all ask within seconds of each other.
export async function getBalance(accountId: string): Promise<{ balance: number; account?: string; bankName?: string }> {
  const w = getWallet(accountId);
  if (w.balanceCache && Date.now() - w.balanceCache.at < BALANCE_TTL_MS && w.accountNumber) {
    return { balance: w.balanceCache.value, account: w.accountNumber, bankName: w.bankName };
  }
  await ensureWallet(accountId);
  const { content } = await getReservedAccountTransactions(w.accountReference);
  const inbound = content.filter((t) => t.paymentStatus === "PAID").reduce((s, t) => s + t.amount, 0);
  const balance = availableFrom(accountId, inbound);
  w.balanceCache = { value: balance, at: Date.now() };
  return { balance, account: w.accountNumber, bankName: w.bankName };
}

// --- Withdrawals ---

export function recordWithdrawal(accountId: string, r: Omit<WithdrawalRecord, "at" | "accountId">): void {
  withdrawals.push({ ...r, accountId, at: Date.now() });
  getWallet(accountId).balanceCache = undefined; // money left — never serve a stale total
}

export function getWithdrawals(accountId: string): WithdrawalRecord[] {
  return withdrawals.filter((r) => r.accountId === accountId).sort((a, b) => b.at - a.at);
}

export function setPayout(accountId: string, account: string, bankCode: string, accountName: string): void {
  const w = getWallet(accountId);
  w.payoutAccount = account;
  w.payoutBankCode = bankCode;
  w.payoutAccountName = accountName;
}

// Step 1 of withdrawal: arm it. Returns the details Aide must read back plus
// the confirm word the user must speak. No money moves here — but the amount
// is checked against the wallet's real available balance up front.
export async function armWithdrawal(accountId: string, amount: number): Promise<
  | { ok: true; amount: number; accountName: string; account: string; phrase: string }
  | { ok: false; message: string }
> {
  const w = getWallet(accountId);
  if (!w.payoutAccount || !w.payoutBankCode || !w.payoutAccountName) {
    return { ok: false, message: "No payout account saved yet. Register one first." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Amount must be a positive number." };
  }
  const { balance } = await getBalance(accountId);
  if (amount > balance) {
    return { ok: false, message: `That is more than the available balance of ${balance} naira.` };
  }
  const phrase = makeConfirmPhrase();
  w.pendingWithdrawal = { amount, phrase, createdAt: Date.now() } satisfies PendingWithdrawal;
  return { ok: true, amount, accountName: w.payoutAccountName, account: w.payoutAccount, phrase };
}

// Step 2 of withdrawal: verify the spoken confirmation against the armed phrase.
// Only a match (within TTL) authorizes the transfer. This is the accessible 2FA gate.
export function verifyWithdrawal(accountId: string, spokenPhrase: string):
  | { ok: true; amount: number; account: string; bankCode: string; accountName: string }
  | { ok: false; message: string } {
  const w = getWallet(accountId);
  const pending = w.pendingWithdrawal;
  if (!pending) return { ok: false, message: "No withdrawal is awaiting confirmation. Start one first." };
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    w.pendingWithdrawal = undefined;
    return { ok: false, message: "The confirmation timed out. Please start the withdrawal again." };
  }
  if (!phraseMatches(spokenPhrase, pending.phrase)) {
    return { ok: false, message: `That didn't match. Ask them to say the word "${pending.phrase}" to confirm.` };
  }
  w.pendingWithdrawal = undefined;
  return {
    ok: true,
    amount: pending.amount,
    account: w.payoutAccount!,
    bankCode: w.payoutBankCode!,
    accountName: w.payoutAccountName!,
  };
}
