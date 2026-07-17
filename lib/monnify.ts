import { createHmac } from "node:crypto";
import { env } from "./env";

type TokenCache = { token: string; expiresAt: number };
let cached: TokenCache | null = null;

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${env.baseUrl}${path}`, init);
  const body = (await res.json()) as { requestSuccessful: boolean; responseMessage: string; responseBody: T };
  if (!res.ok || !body.requestSuccessful) {
    throw new Error(`Monnify ${path} failed (${res.status}): ${body.responseMessage ?? "unknown error"}`);
  }
  return body.responseBody;
}

// Auth: Basic base64(apiKey:secretKey) -> bearer token (~1h). Cached until 60s before expiry.
export async function getToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const basic = Buffer.from(`${env.apiKey}:${env.secretKey}`).toString("base64");
  const body = await call<{ accessToken: string; expiresIn: number }>("/api/v1/auth/login", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });
  cached = { token: body.accessToken, expiresAt: Date.now() + (body.expiresIn - 60) * 1000 };
  return body.accessToken;
}

async function authed<T>(path: string, method: string, payload?: unknown): Promise<T> {
  const token = await getToken();
  return call<T>(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

export type ReservedAccount = {
  accountReference: string;
  accountName: string;
  accounts: { bankCode: string; bankName: string; accountNumber: string }[];
};

// Create a dedicated virtual NUBAN for one user — their earnings account.
export function createReservedAccount(input: {
  accountReference: string;
  accountName: string;
  customerName: string;
  customerEmail: string;
}): Promise<ReservedAccount> {
  return authed<ReservedAccount>("/api/v2/bank-transfer/reserved-accounts", "POST", {
    accountReference: input.accountReference,
    accountName: input.accountName,
    currencyCode: "NGN",
    contractCode: env.contractCode,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    getAllAvailableBanks: true,
  });
}

export type ReservedTxn = { amount: number; paymentStatus: string; transactionReference: string; customerDTO?: { name?: string } };

// List payments made into a reserved account. This is how Aide confirms
// (server-side) that money actually landed before announcing it.
export function getReservedAccountTransactions(accountReference: string): Promise<{ content: ReservedTxn[] }> {
  const ref = encodeURIComponent(accountReference);
  return authed(`/api/v1/bank-transfer/reserved-accounts/transactions?accountReference=${ref}&page=0&size=10`, "GET");
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
  const computed = createHmac("sha512", env.secretKey).update(rawBody).digest("hex");
  return computed === signature;
}
