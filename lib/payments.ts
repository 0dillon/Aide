import { randomUUID } from "node:crypto";
import * as store from "./store";
import { singleTransfer, validateBankAccount } from "./monnify";

// Shared payment actions used by both the agent tools and the /payments page
// API routes, so the voice path and the screen path run the exact same code.
// Everything is per-account: each user acts only on their own wallet.

// Name-enquiry the destination, then save it as this account's payout account.
export async function registerPayout(
  accountId: string,
  accountNumber: string,
  bankCode: string,
): Promise<{ ok: true; accountName: string } | { ok: false; message: string }> {
  try {
    const r = await validateBankAccount(accountNumber, bankCode);
    await store.setPayout(accountId, accountNumber, bankCode, r.accountName);
    return { ok: true, accountName: r.accountName };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// Step 2 of a withdrawal: verify the spoken confirm word, then run the real
// Monnify transfer. Money only moves if the phrase matched within its TTL.
export async function confirmWithdrawal(accountId: string, spokenPhrase: string): Promise<
  | {
      ok: true;
      status: string;
      pending: boolean;
      amount: number;
      message: string;
      // Set when the destination is not yet a saved beneficiary — the UI and
      // Aide both offer to save it after the successful payment.
      offerSaveBeneficiary?: { accountName: string; accountNumber: string; bankCode: string };
    }
  | { ok: false; message: string }
> {
  const check = await store.verifyWithdrawal(accountId, spokenPhrase);
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
    await store.recordWithdrawal(accountId, { amount: check.amount, accountName: check.accountName, status: r.status });

    const known = (await store.listBeneficiaries(accountId)).some(
      (b) => b.accountNumber === check.account && b.bankCode === check.bankCode,
    );
    return {
      ok: true,
      status: r.status,
      pending,
      amount: check.amount,
      message: pending ? "Withdrawal initiated and is being processed." : "Withdrawal completed.",
      offerSaveBeneficiary: known
        ? undefined
        : { accountName: check.accountName, accountNumber: check.account, bankCode: check.bankCode },
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
