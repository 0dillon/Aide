import { ensureAccount, getWithdrawals, getWorker } from "@/lib/store";
import { getReservedAccountTransactions } from "@/lib/monnify";

export const runtime = "nodejs";

// Transaction history: money in comes straight from Monnify (real inbound
// payments to the reserved account); money out is the app's own withdrawal
// ledger.
export async function GET() {
  try {
    await ensureAccount();
    const w = getWorker();
    const inbound = w.accountReference
      ? (await getReservedAccountTransactions(w.accountReference)).content.map((t) => ({
          amount: t.amountPaid ?? t.amount,
          status: t.paymentStatus,
          from: t.customerDTO?.name ?? "Bank transfer",
          reference: t.transactionReference,
          at: t.createdOn ?? null,
        }))
      : [];
    return Response.json({ inbound, outbound: getWithdrawals() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
