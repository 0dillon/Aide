import { randomUUID } from "node:crypto";
import { env } from "./env.js";
import { getToken, createReservedAccount, validateBankAccount, singleTransfer, authorizeTransfer, walletBalance } from "./monnify.js";

const TEST_OTPS = ["123456", "000000"];

// Day-1 live-proof. Answers, mock-free, the questions the whole idea rests on:
//   1. Can we authenticate against the sandbox?
//   2. Can we create a reserved account (a user's earnings wallet)?
//   3. Can we validate a destination account for the spoken read-back?
//   4. Does a disbursement go through WITHOUT a human OTP?  <-- the make-or-break one

const line = () => console.log("─".repeat(60));

async function main() {
  line();
  console.log("AIDE money-loop live-proof — sandbox:", env.baseUrl);
  line();

  console.log("① Auth …");
  await getToken();
  console.log("   ✓ got bearer token\n");

  console.log("② Create reserved account (a user's earnings wallet) …");
  const ref = `aide-${randomUUID().slice(0, 8)}`;
  const account = await createReservedAccount({
    accountReference: ref,
    accountName: "Aide Test Worker",
    customerName: "Aide Test Worker",
    customerEmail: `${ref}@example.com`,
  });
  const nuban = account.accounts?.[0];
  const destAccount = nuban?.accountNumber ?? env.testDestAccount;
  const destBank = nuban?.bankCode ?? env.testDestBankCode;
  console.log(`   ✓ reference: ${account.accountReference}`);
  console.log(`   ✓ pay INTO this to test inbound + webhook: ${destAccount} (${nuban?.bankName})\n`);

  console.log("③ Validate destination account (for Aide's spoken read-back) …");
  try {
    const enquiry = await validateBankAccount(destAccount, destBank);
    console.log(`   ✓ ${destAccount} → "${enquiry.accountName}"\n`);
  } catch (e) {
    console.log(`   ⚠ name enquiry failed: ${(e as Error).message}\n`);
  }

  if (!env.walletAccountNumber) {
    console.log("④ Skipped disbursement: set MONNIFY_WALLET_ACCOUNT_NUMBER in .env first.");
    line();
    return;
  }

  console.log("④ THE BIG ONE — disburse WITHOUT an OTP …");
  try {
    const balance = await walletBalance(env.walletAccountNumber);
    console.log(`   wallet available balance: ₦${balance.availableBalance}`);
  } catch (e) {
    console.log(`   (balance check skipped: ${(e as Error).message})`);
  }
  const transfer = await singleTransfer({
    amount: 100,
    reference: `aide-payout-${randomUUID().slice(0, 8)}`,
    narration: "Aide live-proof payout",
    destinationAccountNumber: destAccount,
    destinationBankCode: destBank,
    destinationAccountName: account.accountName,
  });
  console.log(`   status: ${transfer.status}`);
  line();
  if (transfer.status === "SUCCESS") {
    console.log("✅ NO OTP NEEDED. The screen-free withdrawal flow works. Build it.");
    line();
    return;
  }
  if (transfer.status !== "PENDING_AUTHORIZATION") {
    console.log(`ℹ Unexpected status: ${transfer.status}. Check dashboard Event Logs.`);
    line();
    return;
  }

  console.log("⛔ 2FA is on (PENDING_AUTHORIZATION). Trying to authorize SERVER-SIDE with a test OTP …");
  for (const otp of TEST_OTPS) {
    try {
      const authorized = await authorizeTransfer(transfer.reference, otp);
      console.log(`   OTP ${otp} → ${authorized.status}`);
      if (authorized.status === "SUCCESS") {
        line();
        console.log(`✅ SOLVED. Payout authorized server-side with a fixed test OTP (${otp}).`);
        console.log("   The platform authorizes; the user's voice consent is the security layer.");
        console.log("   No human ever reads an OTP. Build the withdrawal flow.");
        line();
        return;
      }
    } catch (e) {
      console.log(`   OTP ${otp} rejected: ${(e as Error).message}`);
    }
  }
  line();
  console.log("⚠ Fixed test OTP didn't clear it. Fallback: disable transfer 2FA in dashboard");
  console.log("  settings (sandbox), or authorize with the OTP Monnify sends the merchant.");
  line();
}

main().catch((e) => {
  console.error("\n✗ proof failed:", (e as Error).message);
  process.exit(1);
});
