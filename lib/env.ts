import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value.trim();
}

export const env = {
  apiKey: required("MONNIFY_API_KEY"),
  secretKey: required("MONNIFY_SECRET_KEY"),
  baseUrl: (process.env.MONNIFY_BASE_URL ?? "https://sandbox.monnify.com").trim().replace(/\/$/, ""),
  contractCode: required("MONNIFY_CONTRACT_CODE"),
  walletAccountNumber: process.env.MONNIFY_WALLET_ACCOUNT_NUMBER?.trim() ?? "",
  // Monnify requires a BVN or NIN on every reserved account. Real KYC capture
  // is out of scope for the demo — this default is Monnify's sandbox test BVN.
  kycBvn: process.env.MONNIFY_KYC_BVN?.trim() ?? "22222222222",
  testDestAccount: process.env.TEST_DEST_ACCOUNT_NUMBER?.trim() ?? "0000000000",
  testDestBankCode: process.env.TEST_DEST_BANK_CODE?.trim() ?? "058",
  webhookPort: Number(process.env.WEBHOOK_PORT ?? 4000),
};
