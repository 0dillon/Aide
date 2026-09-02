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
// Money-moving calls get their own, far longer budget, for the same reason
// singleTransfer is not retried: a timeout there does not mean the transfer
// failed, it means we do not know. Not retrying stops AIDE sending twice.
// This stops the USER being told to. Abandoning the request at eight seconds
// left confirmWithdrawal reporting failure with no ledger row written, so the
// balance still showed the money and the worker was invited to withdraw it
// again — and this endpoint takes no idempotency key. Wait for the verdict.
const TRANSFER_TIMEOUT_MS = 60_000;
// One retry, because that spread means a slow attempt says almost nothing
// about the next one. A second try usually lands in well under a second, and a
// user staring at a dash would rather wait than be told to come back.
// Retried ONLY on a timeout or a connection failure — never on an HTTP error,
// which is the provider answering, and never on a POST that moves money.
const RETRY_ATTEMPTS = 2;

// When the provider is hard down — not slow, not flaky, but not answering at
// all — retrying is worse than useless: it doubles how long the user waits to
// be told the same thing. Measured against the sandbox during an outage, an
// authenticated login opened its connection in 0.15s and then returned zero
// bytes for thirty seconds, every time. Two attempts of that is a page that
// takes sixteen seconds to show a dash.
//
// So after a run of consecutive failures, stop trying for a while and fail
// immediately instead. The message the user gets is the same; they just get it
// now instead of in sixteen seconds. One probe is allowed through when the
// cooldown lapses, which is how it notices the provider is back.
const BREAKER_AFTER = 3;
const BREAKER_COOLDOWN_MS = 60_000;
let openUntil = 0;

function breakerOpen(): boolean {
  return Date.now() < openUntil;
}

class ProviderDown extends Error {
  readonly transient = true;
  constructor() {
    super("Monnify is not responding — not retrying yet");
  }
}

function isTransient(e: unknown): boolean {
  if (e instanceof ProviderDown) return true;
  const reason = reasonOf(e);
  return /abort|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|UND_ERR/i.test(reason);
}

// A provider outage is not news after the first time. Every failure used to
// print the error object and its stack, so an unreachable host produced a wall
// of identical traces every fifteen seconds and buried every other log on the
// machine. Repeats now collapse into a counter, and recovery says so.
// Keyed by ENDPOINT, not by full path. The path carries account, wallet and
// transaction references, so with the query string in the key every reference
// got its own entry and its own log line — the collapse this exists for never
// happened for the endpoints that vary. Worse, a key is only ever cleared by a
// later success at that same URL, which never comes for a one-shot transaction
// reference, so the map could only grow. A couple of endpoints still carry a
// reference in the path itself, so the cap below is what actually bounds it.
const failing = new Map<string, { reason: string; count: number }>();
const MAX_TRACKED_ROUTES = 100;
const routeOf = (path: string) => path.split("?")[0];
// Consecutive transient failures across ALL paths — one provider, one verdict.
let consecutive = 0;

function reasonOf(e: unknown): string {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (e as Error)?.message ?? "unknown error";
}

function noteFailure(path: string, e: unknown): void {
  // An answered error is never collapsed. It is the provider's verdict on ONE
  // request, usually about one user, and counting it as an outage hid it:
  // twenty withdrawals refused for "Insufficient funds in wallet" share an
  // endpoint and a message, so the counter printed one line and swallowed
  // nineteen. An operator reading that concluded a single user was affected.
  if ((e as { answered?: boolean }).answered) {
    console.error(`[Monnify] ${path} refused: ${reasonOf(e)}`);
    return;
  }

  const route = routeOf(path);
  const reason = reasonOf(e);
  const prev = failing.get(route);
  if (prev?.reason === reason) {
    prev.count += 1;
    // Occasional reminders that it is still down, not one per attempt.
    if (prev.count % 20 === 0) {
      console.error(`[Monnify] ${route} still unreachable (${reason}) — ${prev.count} consecutive failures`);
    }
    return;
  }
  // Bookkeeping about a leak must not become one.
  if (!prev && failing.size >= MAX_TRACKED_ROUTES) {
    const oldest = failing.keys().next().value;
    if (oldest) failing.delete(oldest);
  }
  failing.set(route, { reason, count: 1 });
  console.error(`[Monnify] ${route} failed: ${reason}`);
}

function noteSuccess(path: string): void {
  const route = routeOf(path);
  const prev = failing.get(route);
  if (!prev) return;
  failing.delete(route);
  console.info(`[Monnify] ${route} recovered after ${prev.count} failed attempt(s).`);
}

// What to SAY when the bank rail is unreachable. The raw failures here are
// DOMException("The operation was aborted due to timeout"), ENOTFOUND and
// friends — text that means nothing to anyone and less than nothing read
// aloud to someone who cannot see a retry button. It also has to be honest:
// the balance is unknown, which is not the same as zero, and must never be
// presented as one.
export function spokenProviderError(e: unknown): string {
  const reason = reasonOf(e);
  if (/not responding/i.test(reason)) {
    return "The bank is not responding at the moment, so I could not check your balance. Your money is safe — I will keep trying, and you can ask me again shortly.";
  }
  if (/abort|timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(reason)) {
    return "The bank did not answer in time, so I could not check your balance. Your money is safe — this is only my connection to them. Try again in a moment.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(reason)) {
    return "I could not reach the bank just now, so I could not check your balance. Your money is safe — try again in a moment.";
  }
  return "I could not get your balance from the bank just now. Your money is safe — try again in a moment.";
}

async function attempt<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const res = await fetch(`${env.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
async function call<T>(path: string, init: RequestInit, retry = false, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  // Already known to be down: do not spend the budget finding out again.
  if (breakerOpen()) {
    const down = new ProviderDown();
    noteFailure(path, down);
    throw down;
  }
  const tries = retry ? RETRY_ATTEMPTS : 1;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const out = await attempt<T>(path, init, timeoutMs);
      consecutive = 0;
      openUntil = 0;
      noteSuccess(path);
      return out;
    } catch (e) {
      last = e;
      // An answered error means the provider is up; it just said no.
      if ((e as { answered?: boolean }).answered) {
        consecutive = 0;
        break;
      }
      if (!isTransient(e)) break;
      consecutive += 1;
      if (consecutive >= BREAKER_AFTER) {
        openUntil = Date.now() + BREAKER_COOLDOWN_MS;
        console.error(
          `[Monnify] not responding after ${consecutive} attempts — failing fast for ${BREAKER_COOLDOWN_MS / 1000}s`,
        );
        break;
      }
      if (i === tries - 1) break;
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

async function authed<T>(
  path: string,
  method: string,
  payload?: unknown,
  retry = false,
  timeoutMs?: number,
): Promise<T> {
  const token = await getToken();
  return call<T>(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
    },
    retry,
    timeoutMs,
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
  // Deliberately NOT retried, and given a long budget rather than the eight
  // seconds a read gets. Both follow from the same fact: a timeout here means
  // we do not know whether the transfer went through. Not retrying is what
  // stops Aide sending it twice; waiting for the answer is what stops the user
  // being told it failed and sending it again themselves.
  return authed<TransferResult>(
    "/api/v2/disbursements/single",
    "POST",
    {
      amount: input.amount,
      reference: input.reference,
      narration: input.narration,
      destinationBankCode: input.destinationBankCode,
      destinationAccountNumber: input.destinationAccountNumber,
      destinationAccountName: input.destinationAccountName,
      currency: "NGN",
      sourceAccountNumber: env.walletAccountNumber,
    },
    false,
    TRANSFER_TIMEOUT_MS,
  );
}

export function authorizeTransfer(reference: string, authorizationCode: string): Promise<TransferResult> {
  // Also moves money — same budget, same reasoning as singleTransfer.
  return authed<TransferResult>(
    "/api/v2/disbursements/single/validate-otp",
    "POST",
    { reference, authorizationCode },
    false,
    TRANSFER_TIMEOUT_MS,
  );
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
