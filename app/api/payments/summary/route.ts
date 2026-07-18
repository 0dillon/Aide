import { getBalance, getWorker } from "@/lib/store";

export const runtime = "nodejs";

// Everything the payments page needs in one call. getBalance() lazily mints
// the real Monnify reserved account on first use, then sums confirmed pay.
export async function GET() {
  try {
    const { balance } = await getBalance();
    const w = getWorker();
    return Response.json({
      balance,
      name: w.name,
      accountNumber: w.accountNumber,
      bankName: w.bankName,
      payoutAccount: w.payoutAccount,
      payoutAccountName: w.payoutAccountName,
      pendingWithdrawal: w.pendingWithdrawal ? { amount: w.pendingWithdrawal.amount } : null,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
