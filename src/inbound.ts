import { readFileSync } from "node:fs";
import { getReservedAccountTransactions } from "./monnify.js";

// Polls Monnify for real payments into the reserved account created by
// create-account.ts. This is the server-side confirmation Aide relies on:
// it only announces money that Monnify itself reports as PAID.
const { accountReference, accountNumber } = JSON.parse(readFileSync("account.json", "utf8"));
console.log(`Polling Monnify for payments into ${accountNumber} (${accountReference}) …`);

for (let attempt = 1; attempt <= 20; attempt++) {
  const { content } = await getReservedAccountTransactions(accountReference);
  const paid = content.filter((t) => t.paymentStatus === "PAID");
  if (paid.length > 0) {
    console.log(`\n✅ REAL payment confirmed by Monnify (${paid.length} txn):`);
    for (const t of paid) {
      console.log(`   ₦${t.amount} · ${t.paymentStatus} · ${t.transactionReference}`);
      console.log(`   → Aide would say: "You've been paid ₦${t.amount}."`);
    }
    process.exit(0);
  }
  console.log(`   attempt ${attempt}/20 — no payment yet, waiting 3s …`);
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("\nNo payment detected. Send money to the account in the websim, then re-run.");
process.exit(1);
