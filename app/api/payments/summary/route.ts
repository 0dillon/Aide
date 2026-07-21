import { getAccount, getBalance, getWallet } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Everything the payments page needs in one call, for the signed-in user's
// OWN wallet. getBalance() lazily provisions the real Monnify reserved
// account on first use, then returns confirmed inbound minus withdrawals.
export async function GET(req: Request) {
  try {
    const acc = await getAccount(userIdFrom(req));
    const { balance, account, bankName } = await getBalance(acc.id);
    const wallet = await getWallet(acc.id);
    return Response.json({
      balance,
      name: acc.name,
      role: acc.role,
      accountNumber: account,
      bankName,
      payoutAccount: wallet.payoutAccount,
      payoutAccountName: wallet.payoutAccountName,
      // Workers confirm withdrawals with a personal spoken phrase; the page
      // shows the setup step until one exists.
      hasSecurityPhrase: !!wallet.hasSecurityPhrase,
      pendingWithdrawal: wallet.pendingWithdrawal ? { amount: wallet.pendingWithdrawal.amount } : null,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
