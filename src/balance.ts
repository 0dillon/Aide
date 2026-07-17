import { env } from "./env.js";
import { walletBalance } from "./monnify.js";

if (!env.walletAccountNumber) {
  console.error("Set MONNIFY_WALLET_ACCOUNT_NUMBER in .env first.");
  process.exit(1);
}

const b = await walletBalance(env.walletAccountNumber);
console.log(`wallet ${env.walletAccountNumber}: available ₦${b.availableBalance}, ledger ₦${b.ledgerBalance}`);
