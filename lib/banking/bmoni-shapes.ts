import { toKobo } from "../money";

// The seam between BMONI's JSON and anything Aide is willing to say out loud.
//
// Every shape here was captured from the live sandbox rather than read off the
// documentation, because three of them did not match the documented client
// types — and a field-name mismatch on this API is silent. It is not a 400 and
// not a type error; the property is simply `undefined`, gets persisted, and
// surfaces much later as a 404 on a path containing the word "undefined".
//
// So these parsers throw. None of them defaults, none of them coerces, none of
// them returns a zero it did not read. A parser that guessed would produce a
// confident wrong number, and the person it is read aloud to has no screen to
// check it against.

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`BMONI returned ${Array.isArray(v) ? "an array" : typeof v} where an object was expected`);
  }
  return v as Json;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`BMONI response is missing ${field}`);
  return v;
}

// ---- POST /v1/users ---------------------------------------------------------

// The user comes back wrapped, and carries TWO uuids: `id` (the partner-side
// record) and `bmoniUserId`. Every other endpoint paths on `bmoniUserId`;
// `id` gives "User not found". They are indistinguishable by shape, so this
// picks by name and never by position.
export function parseCreatedUser(body: unknown): { bmoniUserId: string } {
  const user = obj(obj(body).user);
  return { bmoniUserId: str(user.bmoniUserId, "user.bmoniUserId") };
}

// ---- POST …/smart-wallets/create-managed ------------------------------------

// Returns `id` and `walletAddress` — not `smartWalletId` and `address`.
// Also: a wallet requested as CNGN comes back with currency NGN.
export function parseCreatedWallet(body: unknown): { smartWalletId: string; address: string; currency: string } {
  const w = obj(body);
  return {
    smartWalletId: str(w.id, "id"),
    address: str(w.walletAddress, "walletAddress"),
    currency: str(w.currency, "currency"),
  };
}

// ---- GET …/smart-wallets/account/balances -----------------------------------

// `balance` is a decimal STRING, and each entry carries its own `error` inside
// an HTTP 200: BMONI can answer successfully while admitting it could not
// price that particular wallet.
export function parseNgnBalanceKobo(body: unknown): number {
  const list = obj(body).balances;
  if (!Array.isArray(list)) throw new Error("BMONI balances response has no balances array");

  const ngn = list.map(obj).find((b) => b.currency === "NGN");
  if (!ngn) {
    // Not the same fact as "empty". Wallets here can be USD, and a user with
    // no naira wallet has an unknown naira balance, not a zero one.
    const seen = list.map((b) => obj(b).currency).join(", ") || "none";
    throw new Error(`No NGN smart wallet in BMONI balances (currencies present: ${seen})`);
  }
  if (ngn.error) throw new Error(`BMONI could not price the NGN wallet: ${String(ngn.error)}`);

  const raw = str(ngn.balance, "balances[].balance");
  const naira = Number(raw);
  if (!Number.isFinite(naira) || naira < 0) throw new Error(`BMONI reported an unusable NGN balance: ${raw}`);
  return toKobo(naira);
}

// ---- GET …/bank-accounts/deposit-accounts/NGN -------------------------------

// Bkey's own house account, returned to users who have no virtual account of
// their own yet. It is a real, payable NUBAN, which is exactly what makes it
// dangerous: nothing about the response says "this is not yours".
const POOLED_ID = /^pooled-/i;
const POOLED_NAME = /bkey/i;

export function parseNgnDepositAccount(body: unknown): { accountNumber: string; bankName: string } {
  const list = obj(body).accounts;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("BMONI returned no naira deposit account for this user");
  }
  // Filtered, not indexed. Verified against the sandbox: once the virtual
  // account is issued the worker's own account comes FIRST and the pooled one
  // second, but in the seconds before issuance completes the pooled account is
  // the only entry — so `accounts[0]` is sometimes the right answer and
  // sometimes the pooled house account, with nothing in the response to say
  // which. Position cannot be trusted; the pooled one is excluded by identity.
  const own = list.map(obj).filter((a) => {
    const id = typeof a.id === "string" ? a.id : "";
    const name = typeof a.accountName === "string" ? a.accountName : "";
    return !POOLED_ID.test(id) && !POOLED_NAME.test(name);
  });

  if (own.length === 0) {
    // Refusing here is the whole point. Handing the pooled account back would
    // have Aide read a working account number aloud as the worker's own; an
    // employer would pay into a shared pool with no reference tying it to
    // anyone, and the money would be genuinely unrecoverable by this app.
    throw new Error(
      "BMONI lists only its pooled house account for this user, not one of their own. The per-user " +
        "virtual account is issued by Nigerian onboarding and appears a few seconds later — wait and re-read.",
    );
  }
  const a = own[0];
  return { accountNumber: str(a.accountNumber, "accounts[].accountNumber"), bankName: str(a.bankName, "accounts[].bankName") };
}

// ---- GET …/bank-accounts/nigerian-banks -------------------------------------

// Wrapped in `banks`, with bankName/bankCode. The codes are NIBSS institution
// codes (Wema 000017), NOT the 3-digit NIP codes the payments page and Monnify
// use (Wema 035). The two lists are not interchangeable.
export function parseBanks(body: unknown): Array<{ name: string; code: string }> {
  const list = obj(body).banks;
  if (!Array.isArray(list)) throw new Error("BMONI nigerian-banks response has no banks array");
  return list.map(obj).map((b) => ({ name: str(b.bankName, "banks[].bankName"), code: str(b.bankCode, "banks[].bankCode") }));
}

// ---- GET …/smart-wallets/{smartWalletId}/transactions -----------------------

// The wallet's own history. The envelope is verified — `transactions` plus
// page/perPage/total/pageCount/hasNextPage/hasPreviousPage — but no wallet on
// the shared sandbox has a transaction yet, so the ITEM field names below come
// from the SDK's EmbeddedWalletTransaction model, not from observed JSON.
//
// Hence: throw on an item that cannot be read, never skip it. A skipped row is
// a payment a worker is never told about, and they have no screen on which to
// notice the list is short.
export type WalletCredit = { amountKobo: number; reference: string; from?: string; at: number };

// Aide announces money as HAVING ARRIVED. Only a completed credit has.
const ARRIVED = "completed";

export function parseWalletTransactions(body: unknown): WalletCredit[] {
  const list = obj(body).transactions;
  if (!Array.isArray(list)) throw new Error("BMONI transactions response has no transactions array");

  const credits: WalletCredit[] = [];
  for (const raw of list) {
    const t = obj(raw);
    if (String(t.direction).toLowerCase() !== "incoming") continue;
    if (String(t.status).toLowerCase() !== ARRIVED) continue;

    const amount = typeof t.amount === "string" ? Number(t.amount) : t.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new Error(`BMONI credit ${String(t.id)} carries no readable amount`);
    }
    const at = typeof t.createdAt === "number" ? t.createdAt : Date.parse(String(t.createdAt));
    credits.push({
      amountKobo: toKobo(amount),
      reference: str(t.id, "transactions[].id"),
      from: typeof t.counterpartyName === "string" ? t.counterpartyName : undefined,
      at: Number.isFinite(at) ? at : Date.now(),
    });
  }
  return credits;
}
