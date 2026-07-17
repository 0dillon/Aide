import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createReservedAccount } from "./monnify.js";

// Creates one worker earnings account and saves its details so the inbound
// check can poll for payments made to it via the websim.
const ref = `aide-${randomUUID().slice(0, 8)}`;
const account = await createReservedAccount({
  accountReference: ref,
  accountName: "Aide Test Worker",
  customerName: "Aide Test Worker",
  customerEmail: `${ref}@example.com`,
});
const nuban = account.accounts[0];
writeFileSync("account.json", JSON.stringify({ accountReference: ref, accountNumber: nuban.accountNumber, bankName: nuban.bankName }, null, 2));

console.log("Worker earnings account created:");
console.log(`  account number: ${nuban.accountNumber}`);
console.log(`  bank:           ${nuban.bankName}`);
console.log(`  reference:      ${ref}`);
console.log("\nPay this account in the websim, then run:  npm run inbound");
