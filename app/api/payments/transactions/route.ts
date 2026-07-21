import { ensureWallet, getAccount, getWithdrawals } from "@/lib/store";
import { getReservedAccountTransactions } from "@/lib/monnify";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Transaction history for the signed-in user's own wallet: money in comes
// straight from Monnify (real inbound payments to their reserved account);
// money out is the app's own withdrawal ledger for that wallet.
export async function GET(req: Request) {
  try {
    const acc = await getAccount(userIdFrom(req));
    const wallet = await ensureWallet(acc.id);
    const inbound = (await getReservedAccountTransactions(wallet.accountReference)).content.map((t) => ({
      amount: t.amountPaid ?? t.amount,
      status: t.paymentStatus,
      from: t.customerDTO?.name ?? "Bank transfer",
      reference: t.transactionReference,
      at: t.createdOn ?? null,
    }));
    return Response.json({ inbound, outbound: await getWithdrawals(acc.id) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
