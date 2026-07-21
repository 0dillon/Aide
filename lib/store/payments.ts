import { createHash } from "node:crypto";
import { createReservedAccount, getReservedAccount, getReservedAccountTransactions, validateBankAccount } from "../monnify";
import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { getAccount } from "./accounts";
import { type Beneficiary, type Wallet, type WithdrawalRecord } from "./state";

// Per-account Monnify wallets, now backed by Convex so balances, payout
// destinations, and armed withdrawals are shared across serverless instances.
// available = confirmed inbound transfers to this wallet's NUBAN − this
// wallet's withdrawals (the Convex ledger).

const CONFIRM_WORDS = ["mango", "sunrise", "guitar", "river", "orange", "candle", "harvest", "compass"];
const PENDING_TTL_MS = 5 * 60 * 1000;
const BALANCE_TTL_MS = 20_000;

// A spoken confirmation cannot defend against someone standing in the room —
// they hear the word Aide reads out. What actually protects the money is that
// it may only ever leave to a destination registered EARLIER, so redirecting it
// takes time rather than a moment of opportunity. This is the same "new
// beneficiary" hold banks apply. Kept short by default so the flow stays
// demonstrable; production would use hours.
const PAYOUT_COOLING_OFF_MS = Number(process.env.PAYOUT_COOLING_OFF_MS ?? 2 * 60 * 1000);

// A single spoken instruction should never be able to empty an account.
const MAX_WITHDRAWAL = Number(process.env.MAX_WITHDRAWAL_NGN ?? 100_000);

function makeConfirmPhrase(): string {
  return CONFIRM_WORDS[Math.floor(Math.random() * CONFIRM_WORDS.length)];
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

type WalletDoc = {
  accountId: string;
  accountReference: string;
  status: "unprovisioned" | "active" | "failed";
  accountNumber?: string;
  bankName?: string;
  lastError?: string;
  payoutAccount?: string;
  payoutBankCode?: string;
  payoutAccountName?: string;
  payoutSetAt?: number;
  securityPhraseHash?: string;
  pendingWithdrawal?: Wallet["pendingWithdrawal"];
  knownTxRefs?: string[];
  txSeeded?: boolean;
};

function toWallet(d: WalletDoc): Wallet {
  return {
    accountId: d.accountId,
    accountReference: d.accountReference,
    status: d.status,
    accountNumber: d.accountNumber,
    bankName: d.bankName,
    lastError: d.lastError,
    payoutAccount: d.payoutAccount,
    payoutBankCode: d.payoutBankCode,
    payoutAccountName: d.payoutAccountName,
    payoutSetAt: d.payoutSetAt,
    hasSecurityPhrase: !!d.securityPhraseHash,
    pendingWithdrawal: d.pendingWithdrawal,
    knownTxRefs: new Set(d.knownTxRefs ?? []),
    txSeeded: d.txSeeded ?? false,
  };
}

export async function getWallet(accountId: string): Promise<Wallet> {
  const accountReference = walletReferenceFor(accountId);
  const d = (await convexClient().query(api.wallets.getByAccount, { accountId })) as WalletDoc | null;
  if (d) return toWallet(d);
  await convexClient().mutation(api.wallets.ensure, { accountId, accountReference });
  return { accountId, accountReference, status: "unprovisioned", knownTxRefs: new Set(), txSeeded: false };
}

export async function listActiveWallets(): Promise<Wallet[]> {
  const docs = (await convexClient().query(api.wallets.listActive, {})) as WalletDoc[];
  return docs.map(toWallet);
}

// One in-flight provisioning per account PER INSTANCE — signup's background
// call and a concurrent balance request must not both hit Monnify's create
// endpoint. getReservedAccount-first also makes provisioning idempotent by
// reference across instances.
const inFlight = new Map<string, Promise<Wallet>>();

export function ensureWallet(accountId: string): Promise<Wallet> {
  const running = inFlight.get(accountId);
  if (running) return running;

  const p = (async () => {
    const wallet = await getWallet(accountId);
    if (wallet.status === "active") return wallet;
    const acc = await getAccount(accountId);
    const ref = wallet.accountReference;
    let reserved;
    try {
      reserved = await getReservedAccount(ref);
    } catch {
      reserved = await createReservedAccount({
        accountReference: ref,
        accountName: acc.name,
        customerName: acc.name,
        // customerEmail must be unique per reserved account on Monnify.
        customerEmail: acc.email || `${ref}@aide.test`,
      });
    }
    const accountNumber = reserved.accounts[0].accountNumber;
    const bankName = reserved.accounts[0].bankName;
    await convexClient().mutation(api.wallets.setProvisioned, { accountId, accountReference: ref, accountNumber, bankName });
    return { ...wallet, status: "active" as const, accountNumber, bankName, lastError: undefined };
  })();

  inFlight.set(
    accountId,
    p.catch(async (e) => {
      await convexClient().mutation(api.wallets.setFailed, {
        accountId,
        accountReference: walletReferenceFor(accountId),
        lastError: (e as Error).message,
      });
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

// Brief per-instance cache — the greeting, payments page, and agent all ask
// within seconds. Withdrawals invalidate it; a 20s TTL bounds staleness.
const balanceCache = new Map<string, { value: number; at: number }>();

async function availableFrom(accountId: string, inboundTotal: number): Promise<number> {
  const withdrawn = (await convexClient().query(api.wallets.withdrawnTotal, { accountId })) as number;
  return Math.max(0, inboundTotal - withdrawn);
}

export async function cacheWalletBalance(accountId: string, inboundTotal: number): Promise<void> {
  balanceCache.set(accountId, { value: await availableFrom(accountId, inboundTotal), at: Date.now() });
}

// Real, isolated balance: confirmed inbound transfers to THIS wallet's NUBAN
// minus this wallet's withdrawals.
export async function getBalance(accountId: string): Promise<{ balance: number; account?: string; bankName?: string }> {
  const w = await ensureWallet(accountId);
  const cached = balanceCache.get(accountId);
  if (cached && Date.now() - cached.at < BALANCE_TTL_MS && w.accountNumber) {
    return { balance: cached.value, account: w.accountNumber, bankName: w.bankName };
  }
  const { content } = await getReservedAccountTransactions(w.accountReference);
  const inbound = content.filter((t) => t.paymentStatus === "PAID").reduce((s, t) => s + t.amount, 0);
  const balance = await availableFrom(accountId, inbound);
  balanceCache.set(accountId, { value: balance, at: Date.now() });
  return { balance, account: w.accountNumber, bankName: w.bankName };
}

// --- Withdrawals ---

export async function recordWithdrawal(accountId: string, r: Omit<WithdrawalRecord, "at" | "accountId">): Promise<void> {
  await convexClient().mutation(api.wallets.recordWithdrawal, { accountId, amount: r.amount, accountName: r.accountName, status: r.status, at: Date.now() });
  balanceCache.delete(accountId); // money left — never serve a stale total
}

export async function getWithdrawals(accountId: string): Promise<WithdrawalRecord[]> {
  const rows = (await convexClient().query(api.wallets.listWithdrawals, { accountId })) as WithdrawalRecord[];
  return rows.map((r) => ({ accountId: r.accountId, amount: r.amount, accountName: r.accountName, status: r.status, at: r.at }));
}

export async function setPayout(accountId: string, account: string, bankCode: string, accountName: string): Promise<void> {
  await convexClient().mutation(api.wallets.setPayout, {
    accountId,
    accountReference: walletReferenceFor(accountId),
    payoutAccount: account,
    payoutBankCode: bankCode,
    payoutAccountName: accountName,
  });
}

// --- Spoken security phrase (workers' accessible replacement for SMS OTP) ---

// Normalize + hash: forgiving of case, punctuation, and spacing, since the
// phrase arrives via imperfect speech recognition.
function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function hashPhrase(text: string): string {
  return createHash("sha256").update(normalizePhrase(text)).digest("hex");
}

// All contiguous word-windows of the spoken text, hashed — so "my phrase is
// sunny garden gate" still matches a stored "sunny garden gate".
function candidateHashesFor(spoken: string): string[] {
  const words = normalizePhrase(spoken).split(" ").filter(Boolean);
  const out = new Set<string>();
  const MAX_WINDOW = 8;
  for (let len = 1; len <= Math.min(words.length, MAX_WINDOW); len++) {
    for (let i = 0; i + len <= words.length; i++) {
      out.add(createHash("sha256").update(words.slice(i, i + len).join(" ")).digest("hex"));
    }
  }
  return [...out];
}

export async function setSecurityPhrase(accountId: string, phrase: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const normalized = normalizePhrase(phrase);
  if (normalized.split(" ").length < 2 || normalized.length < 8) {
    return { ok: false, message: "The security phrase should be at least two words — something memorable only you would say." };
  }
  await convexClient().mutation(api.wallets.setSecurityPhrase, {
    accountId,
    accountReference: walletReferenceFor(accountId),
    hash: hashPhrase(phrase),
  });
  return { ok: true };
}

// --- Beneficiaries: saved withdrawal destinations ---

export async function listBeneficiaries(accountId: string): Promise<Beneficiary[]> {
  const rows = (await convexClient().query(api.wallets.listBeneficiaries, { accountId })) as Beneficiary[];
  return rows.map((b) => ({
    accountId: b.accountId,
    accountName: b.accountName,
    accountNumber: b.accountNumber,
    bankCode: b.bankCode,
    bankName: b.bankName,
    at: b.at,
  }));
}

export async function saveBeneficiary(
  accountId: string,
  b: { accountName: string; accountNumber: string; bankCode: string; bankName?: string },
): Promise<{ created: boolean }> {
  return await convexClient().mutation(api.wallets.saveBeneficiary, { accountId, ...b, at: Date.now() });
}

// Where a withdrawal should go. Explicit account details are name-enquiry
// verified; a beneficiary is matched by (partial) name; with neither, a sole
// beneficiary or the legacy saved payout account is used.
export type WithdrawalDestination = { accountNumber?: string; bankCode?: string; beneficiaryName?: string };

async function resolveDestination(
  accountId: string,
  dest: WithdrawalDestination | undefined,
  wallet: Wallet,
): Promise<{ ok: true; account: string; bankCode: string; accountName: string; addedAt?: number } | { ok: false; message: string }> {
  if (dest?.accountNumber && dest?.bankCode) {
    try {
      const r = await validateBankAccount(dest.accountNumber.trim(), dest.bankCode.trim());
      return { ok: true, account: r.accountNumber, bankCode: dest.bankCode.trim(), accountName: r.accountName, addedAt: Date.now() };
    } catch {
      return { ok: false, message: "Bank details not found — check the account number and bank, then try again." };
    }
  }
  const beneficiaries = await listBeneficiaries(accountId);
  if (dest?.beneficiaryName) {
    const q = dest.beneficiaryName.trim().toLowerCase();
    const matches = beneficiaries.filter((b) => b.accountName.toLowerCase().includes(q));
    if (matches.length === 1) {
      const b = matches[0];
      return { ok: true, account: b.accountNumber, bankCode: b.bankCode, accountName: b.accountName, addedAt: b.at };
    }
    if (matches.length > 1) {
      return { ok: false, message: `More than one saved beneficiary matches "${dest.beneficiaryName}" — say the full name.` };
    }
    return { ok: false, message: `No saved beneficiary matches "${dest.beneficiaryName}". Give the account number and bank instead.` };
  }
  if (beneficiaries.length === 1) {
    const b = beneficiaries[0];
    return { ok: true, account: b.accountNumber, bankCode: b.bankCode, accountName: b.accountName, addedAt: b.at };
  }
  if (beneficiaries.length > 1) {
    const names = beneficiaries.map((b) => b.accountName).join(", ");
    return { ok: false, message: `Which account should the money go to? Your saved beneficiaries are: ${names}. Or give a new account number and bank.` };
  }
  if (wallet.payoutAccount && wallet.payoutBankCode && wallet.payoutAccountName) {
    return { ok: true, account: wallet.payoutAccount, bankCode: wallet.payoutBankCode, accountName: wallet.payoutAccountName, addedAt: wallet.payoutSetAt };
  }
  return { ok: false, message: "No destination account. Give the account number and the bank the money should go to." };
}

// Step 1 of withdrawal: arm it, with its own destination. No money moves here —
// the amount is checked against the wallet's real available balance up front,
// and the destination is verified by name enquiry. Workers confirm with their
// personal spoken security phrase (the accessible OTP replacement); employers
// confirm with a per-withdrawal random word.
export async function armWithdrawal(accountId: string, amount: number, dest?: WithdrawalDestination): Promise<
  | { ok: true; amount: number; accountName: string; account: string; mode: "word" | "passphrase"; phrase?: string }
  | { ok: false; message: string; needsSecurityPhrase?: boolean }
> {
  const w = await getWallet(accountId);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Amount must be a positive number." };
  }
  if (amount > MAX_WITHDRAWAL) {
    return {
      ok: false,
      message: `For safety, a single withdrawal cannot be more than ${MAX_WITHDRAWAL} naira. Take it out in smaller amounts.`,
    };
  }
  const acc = await getAccount(accountId);
  const mode: "word" | "passphrase" = acc.role === "worker" ? "passphrase" : "word";
  if (mode === "passphrase" && !w.hasSecurityPhrase) {
    return {
      ok: false,
      needsSecurityPhrase: true,
      message:
        "You need a spoken security phrase before withdrawing — it replaces the SMS code. Choose a short phrase only you would know, and set it first.",
    };
  }
  const resolved = await resolveDestination(accountId, dest, w);
  if (!resolved.ok) return resolved;

  // New-beneficiary hold: money may only go to a destination that was already
  // registered before now, so someone who gains a moment of access cannot point
  // the account at themselves and drain it in the same sitting.
  const heldFor = resolved.addedAt ? Date.now() - resolved.addedAt : PAYOUT_COOLING_OFF_MS;
  if (heldFor < PAYOUT_COOLING_OFF_MS) {
    const mins = Math.max(1, Math.ceil((PAYOUT_COOLING_OFF_MS - heldFor) / 60000));
    return {
      ok: false,
      message: `That payout account was only just added, so it is on hold for about ${mins} more minute${mins === 1 ? "" : "s"} for your safety. You can withdraw to it after that.`,
    };
  }
  const { balance } = await getBalance(accountId);
  if (amount > balance) {
    return { ok: false, message: `That is more than the available balance of ${balance} naira.` };
  }
  const phrase = makeConfirmPhrase();
  await convexClient().mutation(api.wallets.armPending, {
    accountId,
    amount,
    phrase,
    mode,
    destAccount: resolved.account,
    destBankCode: resolved.bankCode,
    destAccountName: resolved.accountName,
    createdAt: Date.now(),
  });
  return {
    ok: true,
    amount,
    accountName: resolved.accountName,
    account: resolved.account,
    mode,
    // The random word is only revealed for word mode; a worker's security
    // phrase is theirs and is never echoed back.
    phrase: mode === "word" ? phrase : undefined,
  };
}

// Step 2 of withdrawal: verify what was spoken against the armed check.
// The check-and-clear is a single atomic Convex mutation, so two concurrent
// confirmations can never both authorize the same transfer. This is the
// consent gate — deliberately NOT called a second factor: anyone in the room
// hears the word, so it proves intent, not identity.
export async function verifyWithdrawal(accountId: string, spokenPhrase: string): Promise<
  | { ok: true; amount: number; account: string; bankCode: string; accountName: string }
  | { ok: false; message: string }
> {
  const r = await convexClient().mutation(api.wallets.consumePending, {
    accountId,
    spokenPhrase,
    candidateHashes: candidateHashesFor(spokenPhrase),
    now: Date.now(),
    ttlMs: PENDING_TTL_MS,
  });
  if (!r.ok) {
    if (r.reason === "none") return { ok: false, message: "No withdrawal is awaiting confirmation. Start one first." };
    if (r.reason === "expired") return { ok: false, message: "The confirmation timed out. Please start the withdrawal again." };
    if (r.mode === "passphrase") {
      return { ok: false, message: "That didn't match your security phrase. Please say your security phrase to confirm." };
    }
    return { ok: false, message: `That didn't match. Ask them to say the word "${r.phrase}" to confirm.` };
  }
  return {
    ok: true,
    amount: r.amount,
    account: r.payoutAccount!,
    bankCode: r.payoutBankCode!,
    accountName: r.payoutAccountName!,
  };
}
