import { ensureWallet, getAccount, getWithdrawals } from "@/lib/store";
import { getReservedAccountTransactions, spokenProviderError } from "@/lib/monnify";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
// Talks to the bank, which can be slow. The platform default is short enough
// to kill the request before our own timeout can report why it failed.
export const maxDuration = 30;

// Transaction history for the signed-in user's own wallet: money in comes
// straight from Monnify (real inbound payments to their reserved account);
// money out is the app's own withdrawal ledger for that wallet.
// Money OUT is our own ledger and always available. Money IN comes from the
// bank, so it can be missing while the rest is fine — half a history is more
// use than a 500, and the withdrawals half is the half we can always vouch for.
export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req)).catch(() => null);
  if (!acc) {
    return Response.json({ error: "I could not load your account just now. Try again in a moment." }, { status: 500 });
  }

  const outbound = await getWithdrawals(acc.id).catch(() => []);

  try {
    const wallet = await ensureWallet(acc.id);
    const inbound = (await getReservedAccountTransactions(wallet.accountReference)).content.map((t) => ({
      amount: t.amountPaid ?? t.amount,
      status: t.paymentStatus,
      from: t.customerDTO?.name ?? "Bank transfer",
      reference: t.transactionReference,
      at: t.createdOn ?? null,
    }));
    return Response.json({ inbound, outbound });
  } catch (e) {
    // Not an error the page should fail on: say what is missing and show the
    // rest. Never an empty list presented as "no payments" — that reads as
    // "nobody paid you", which is a different and much worse claim.
    return Response.json({ inbound: null, inboundUnavailable: spokenProviderError(e), outbound });
  }
}
