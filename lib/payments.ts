import { randomUUID } from "node:crypto";
import * as store from "./store";
import { singleTransfer, validateBankAccount } from "./monnify";

// Shared payment actions used by both the agent tools and the /payments page
// API routes, so the voice path and the screen path run the exact same code.

// Name-enquiry the destination, then save it as the worker's payout account.
export async function registerPayout(
  accountNumber: string,
  bankCode: string,
): Promise<{ ok: true; accountName: string } | { ok: false; message: string }> {
  try {
    const r = await validateBankAccount(accountNumber, bankCode);
    store.setPayout(accountNumber, bankCode, r.accountName);
    return { ok: true, accountName: r.accountName };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// Step 2 of a withdrawal: verify the spoken confirm word, then run the real
// Monnify transfer. Money only moves if the phrase matched within its TTL.
export async function confirmWithdrawal(spokenPhrase: string): Promise<
  | { ok: true; status: string; pending: boolean; amount: number; message: string }
  | { ok: false; message: string }
> {
  const check = store.verifyWithdrawal(spokenPhrase);
  if (!check.ok) return check;
  try {
    const r = await singleTransfer({
      amount: check.amount,
      reference: `aide-wd-${randomUUID().slice(0, 8)}`,
      narration: "Aide withdrawal",
      destinationAccountNumber: check.account,
      destinationBankCode: check.bankCode,
      destinationAccountName: check.accountName,
    });
    const pending = r.status === "PENDING_AUTHORIZATION";
    store.recordWithdrawal({ amount: check.amount, accountName: check.accountName, status: r.status });
    return {
      ok: true,
      status: r.status,
      pending,
      amount: check.amount,
      message: pending ? "Withdrawal initiated and is being processed." : "Withdrawal completed.",
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
