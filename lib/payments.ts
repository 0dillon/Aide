import * as store from "./store";
import { paymentProvider } from "./banking";
import { toKobo } from "./money";
import { spokenClientError } from "./spoken-error";

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
    const r = await paymentProvider().verifyDestination(accountId, accountNumber, bankCode);
    await store.setPayout(accountId, accountNumber, bankCode, r.accountName);
    return { ok: true, accountName: r.accountName };
  } catch (e) {
    // Spoken by Aide. Genuine bank responses ("account not found") pass
    // through; DOMException and socket text does not.
    return { ok: false, message: spokenClientError((e as Error).message) };
  }
}

// Step 2 of a withdrawal: verify the spoken confirm word, then run the real
// transfer through whichever provider is live. Money only moves if the phrase
// matched within its TTL.
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
  const provider = paymentProvider();

  // BMONI registers a withdrawal destination by name as well as code, and the
  // armed withdrawal only stored the code. Resolved from the provider's own
  // list so the spelling is theirs — a name we invented would be rejected at
  // registration, after the worker has already spoken their security phrase.
  const bankName = (await provider.listBanks(accountId).catch(() => [])).find(
    (b) => b.code === check.bankCode,
  )?.name;

  try {
    // One attempt, no retry, no early abort — the rule lives inside each
    // adapter. Kobo across the seam; `check.amount` is naira.
    const r = await provider.payOut({
      accountId,
      amountKobo: toKobo(check.amount),
      accountNumber: check.account,
      bankCode: check.bankCode,
      bankName: bankName ?? "",
      accountName: check.accountName,
    });

    // An unknown outcome is never a completion. `pending` is what stops Aide
    // saying the money has arrived, so anything that is not an outright
    // success has to set it — including "unknown", where the transfer may well
    // have gone through and we simply cannot say so yet.
    const pending = r.state !== "completed";
    const status = r.state === "completed" ? "SUCCESS" : r.state === "failed" ? "FAILED" : "PENDING";
    if (r.state === "failed") {
      return { ok: false, message: "The transfer did not go through. Your money is still in your account." };
    }
    await store.recordWithdrawal(accountId, { amount: check.amount, accountName: check.accountName, status });

    const known = (await store.listBeneficiaries(accountId)).some(
      (b) => b.accountNumber === check.account && b.bankCode === check.bankCode,
    );
    return {
      ok: true,
      status,
      pending,
      amount: check.amount,
      message: pending ? "Withdrawal initiated and is being processed." : "Withdrawal completed.",
      offerSaveBeneficiary: known
        ? undefined
        : { accountName: check.accountName, accountNumber: check.account, bankCode: check.bankCode },
    };
  } catch (e) {
    // Spoken by Aide. Genuine bank responses ("account not found") pass
    // through; DOMException and socket text does not.
    return { ok: false, message: spokenClientError((e as Error).message) };
  }
}
