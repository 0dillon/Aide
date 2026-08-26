import { getAccount, getBalance, getWallet } from "@/lib/store";
import { spokenProviderError } from "@/lib/monnify";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
// Provisioning a reserved account and then reading its transactions is several
// sequential calls to the bank, each with its own timeout. The platform default
// is short enough to kill the request before our own timeout can report why.
export const maxDuration = 30;

// Everything the payments page needs in one call, for the signed-in user's
// OWN wallet.
//
// Only the BALANCE needs the bank. The account number, the bank name, the
// payout details and the pending withdrawal all live in Convex. When the rail
// is slow or down, the whole page used to fail with whatever the fetch threw —
// which is how a blind user ended up being read "The operation was aborted due
// to timeout". Now the page still loads with everything we actually know, and
// the balance alone comes back unknown, with something worth hearing.
//
// Unknown is NOT zero, and is never rendered as one: `balance` is null and the
// page says so rather than showing a number nobody verified.
export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req)).catch(() => null);
  if (!acc) {
    return Response.json({ error: "I could not load your account just now. Try again in a moment." }, { status: 500 });
  }

  const [balanceResult, wallet] = await Promise.all([
    getBalance(acc.id).then(
      (b) => ({ ok: true as const, ...b }),
      (e) => ({ ok: false as const, message: spokenProviderError(e) }),
    ),
    getWallet(acc.id).catch(() => null),
  ]);

  return Response.json({
    balance: balanceResult.ok ? balanceResult.balance : null,
    balanceUnavailable: balanceResult.ok ? undefined : balanceResult.message,
    name: acc.name,
    role: acc.role,
    // The bank call may have failed, but Convex still knows the account.
    accountNumber: (balanceResult.ok ? balanceResult.account : undefined) ?? wallet?.accountNumber,
    bankName: (balanceResult.ok ? balanceResult.bankName : undefined) ?? wallet?.bankName,
    payoutAccount: wallet?.payoutAccount,
    payoutAccountName: wallet?.payoutAccountName,
    // Workers confirm withdrawals with a personal spoken phrase; the page
    // shows the setup step until one exists.
    hasSecurityPhrase: !!wallet?.hasSecurityPhrase,
    pendingWithdrawal: wallet?.pendingWithdrawal ? { amount: wallet.pendingWithdrawal.amount } : null,
  });
}
