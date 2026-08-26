import { createHmac } from "node:crypto";
import { env } from "./env";

type TokenCache = { token: string; expiresAt: number };
let cached: TokenCache | null = null;

// Fail fast rather than sitting on a connection that is not going to open. The
// default is around ten seconds, which is a long time to hold a request that is
// already doomed.
//
// The sandbox's latency is not merely slow, it is erratic: the same auth call
// measured 0.5s, 4.1s and 13.6s in three consecutive attempts, the last of
// which spent 13.2s just opening the connection. One budget cannot serve both
// callers, so there are two.
const CALL_TIMEOUT_MS = 8000;
// One retry, because that spread means a slow attempt says almost nothing
// about the next one. A second try usually lands in well under a second, and a
// user staring at a dash would rather wait than be told to come back.
// Retried ONLY on a timeout or a connection failure — never on an HTTP error,
// which is the provider answering, and never on a POST that moves money.
const RETRY_ATTEMPTS = 2;

function isTransient(e: unknown): boolean {
  const reason = reasonOf(e);
  return /abort|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|UND_ERR/i.test(reason);
}

// A provider outage is not news after the first time. Every failure used to
// print the error object and its stack, so an unreachable host produced a wall
// of identical traces every fifteen seconds and buried every other log on the
// machine. Repeats now collapse into a counter, and recovery says so.
const failing = new Map<string, { reason: string; count: number }>();

function reasonOf(e: unknown): string {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (e as Error)?.message ?? "unknown error";
}

function noteFailure(path: string, e: unknown): void {
  const reason = reasonOf(e);
  const prev = failing.get(path);
  if (prev?.reason === reason) {
    prev.count += 1;
    // Occasional reminders that it is still down, not one per attempt.
    if (prev.count % 20 === 0) {
      console.error(`[Monnify] ${path} still unreachable (${reason}) — ${prev.count} consecutive failures`);
    }
    return;
  }
  failing.set(path, { reason, count: 1 });
  console.error(`[Monnify] ${path} failed: ${reason}`);
}

function noteSuccess(path: string): void {
  const prev = failing.get(path);
  if (!prev) return;
  failing.delete(path);
  console.info(`[Monnify] ${path} recovered after ${prev.count} failed attempt(s).`);
}

// What to SAY when the bank rail is unreachable. The raw failures here are
// DOMException("The operation was aborted due to timeout"), ENOTFOUND and
// friends — text that means nothing to anyone and less than nothing read
// aloud to someone who cannot see a retry button. It also has to be honest:
// the balance is unknown, which is not the same as zero, and must never be
// presented as one.
export function spokenProviderError(e: unknown): string {
  const reason = reasonOf(e);
  if (/abort|timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(reason)) {
    return "The bank did not answer in time, so I could not check your balance. Your money is safe — this is only my connection to them. Try again in a moment.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(reason)) {
    return "I could not reach the bank just now, so I could not check your balance. Your money is safe — try again in a moment.";
  }
  return "I could not get your balance from the bank just now. Your money is safe — try again in a moment.";
}

async function attempt<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${env.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const body = (await res.json()) as { requestSuccessful: boolean; responseMessage: string; responseBody: T };
  if (!res.ok || !body.requestSuccessful) {
    // The provider answered. Retrying will get the same answer, and on a
    // money-moving call it might get a second transfer instead.
    throw Object.assign(new Error(`Monnify ${path} failed (${res.status}): ${body.responseMessage ?? "unknown error"}`), {
      answered: true,
    });
  }
  return body.responseBody;
}

// `retry` defaults to false so a caller has to opt in. Reads are safe to
// repeat; anything that moves money is not, and must never be retried blind.
async function call<T>(path: string, init: RequestInit, retry = false): Promise<T> {
  const tries = retry ? RETRY_ATTEMPTS : 1;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const out = await attempt<T>(path, init);
      noteSuccess(path);
      return out;
    } catch (e) {
      last = e;
      if ((e as { answered?: boolean }).answered || !isTransient(e) || i === tries - 1) break;
      console.warn(`[Monnify] ${path} ${reasonOf(e)} — retrying once`);
    }
  }
  noteFailure(path, last);
  throw last;
}

// Auth: Basic base64(apiKey:secretKey) -> bearer token (~1h). Cached until 60s before expiry.
export async function getToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const basic = Buffer.from(`${env.apiKey}:${env.secretKey}`).toString("base64");
  // Retried: this is a read of a token, it moves nothing, and it is the call
  // most likely to be the slow one — everything else waits behind it.
  const body = await call<{ accessToken: string; expiresIn: number }>(
    "/api/v1/auth/login",
    { method: "POST", headers: { Authorization: `Basic ${basic}` } },
    true,
  );
  cached = { token: body.accessToken, expiresAt: Date.now() + (body.expiresIn - 60) * 1000 };
  return body.accessToken;
}

async function authed<T>(path: string, method: string, payload?: unknown, retry = false): Promise<T> {
  const token = await getToken();
  return call<T>(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
    },
    retry,
  );
}

export type ReservedAccount = {
  accountReference: string;
  accountName: string;
  accounts: { bankCode: string; bankName: string; accountNumber: string }[];
};

// Create a dedicated virtual NUBAN for one user — their wallet. Monnify
// requires a BVN or NIN on every reserved account (compliance); at least one
// must be provided.
export function createReservedAccount(input: {
  accountReference: string;
  accountName: string;
  customerName: string;
  customerEmail: string;
  bvn?: string;
  nin?: string;
}): Promise<ReservedAccount> {
  return authed<ReservedAccount>("/api/v2/bank-transfer/reserved-accounts", "POST", {
    accountReference: input.accountReference,
    accountName: input.accountName,
    currencyCode: "NGN",
    contractCode: env.contractCode,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    bvn: input.bvn ?? (input.nin ? undefined : env.kycBvn),
    nin: input.nin,
    getAllAvailableBanks: true,
  });
}

// Fetch an existing reserved account by its reference — lets the app reuse
// the same NUBAN across server restarts instead of trying to mint a new one
// (Monnify allows only one reserved account per customer).
export function getReservedAccount(accountReference: string): Promise<ReservedAccount> {
  return authed<ReservedAccount>(
    `/api/v2/bank-transfer/reserved-accounts/${encodeURIComponent(accountReference)}`,
    "GET",
    undefined,
    true,
  );
}

export type ReservedTxn = {
  amount: number;
  amountPaid?: number;
  paymentStatus: string;
  transactionReference: string;
  paymentDescription?: string;
  createdOn?: number | string;
  customerDTO?: { name?: string };
};

// List payments made into a reserved account. This is how Aide confirms
// (server-side) that money actually landed before announcing it.
export async function getReservedAccountTransactions(accountReference: string): Promise<{ content: ReservedTxn[] }> {
  const ref = encodeURIComponent(accountReference);
  const all: ReservedTxn[] = [];
  let page = 0;
  while (true) {
    // Retried: a read, and the call the payments page is waiting on. This is
    // where an erratic sandbox turned into "I could not check your balance".
    const res = await authed<{ content: ReservedTxn[] }>(
      `/api/v1/bank-transfer/reserved-accounts/transactions?accountReference=${ref}&page=${page}&size=100`,
      "GET",
      undefined,
      true,
    );
    all.push(...res.content);
    if (res.content.length < 100) break;
    page++;
  }
  return { content: all };
}

// Re-fetch a transaction server-side. NEVER trust a webhook payload alone.
export function verifyTransaction(transactionReference: string): Promise<{ paymentStatus: string; amountPaid: number }> {
  const ref = encodeURIComponent(transactionReference);
  return authed(`/api/v2/transactions/${ref}`, "GET");
}

// Name enquiry — confirm the destination account before Aide reads it back.
export function validateBankAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string; accountNumber: string; bankCode: string }> {
  return authed(`/api/v1/disbursements/account/validate?accountNumber=${accountNumber}&bankCode=${bankCode}`, "GET");
}

export type TransferResult = { reference: string; status: string; amount: number; destinationAccountName?: string };

// Single disbursement. `status`:
//   SUCCESS               -> completed
//   PENDING_AUTHORIZATION -> 2FA/OTP required (or activation pending)
export function singleTransfer(input: {
  amount: number;
  reference: string;
  narration: string;
  destinationAccountNumber: string;
  destinationBankCode: string;
  destinationAccountName: string;
}): Promise<TransferResult> {
  // Deliberately NOT retried. A timeout here means we do not know whether the
  // transfer went through, and trying again could send the money twice.
  return authed<TransferResult>("/api/v2/disbursements/single", "POST", {
    amount: input.amount,
    reference: input.reference,
    narration: input.narration,
    destinationBankCode: input.destinationBankCode,
    destinationAccountNumber: input.destinationAccountNumber,
    destinationAccountName: input.destinationAccountName,
    currency: "NGN",
    sourceAccountNumber: env.walletAccountNumber,
  });
}

export function authorizeTransfer(reference: string, authorizationCode: string): Promise<TransferResult> {
  return authed<TransferResult>("/api/v2/disbursements/single/validate-otp", "POST", { reference, authorizationCode });
}

export function walletBalance(walletId: string): Promise<{ availableBalance: number; ledgerBalance: number }> {
  return authed(`/api/v1/disbursements/wallet-balance?walletId=${walletId}`, "GET");
}

// Verify an inbound webhook: SHA-512 HMAC of the RAW body using the secret key.
export function isValidWebhook(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  // Bound payload size to prevent OOM via massive hashing (max 512KB)
  if (rawBody.length > 512 * 1024) return false;
  const computed = createHmac("sha512", env.secretKey).update(rawBody).digest("hex");
  return computed === signature;
}
