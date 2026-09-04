import { getAccount, getWithdrawals } from "@/lib/store";
import { paymentProvider } from "@/lib/banking";
import { spokenProviderError } from "@/lib/monnify";
import { toNaira } from "@/lib/money";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
// Talks to the bank, which can be slow. The platform default is short enough
// to kill the request before our own timeout can report why it failed.
export const maxDuration = 30;

// Transaction history for the signed-in user's own wallet: money in comes from
// whichever provider holds the money; money out is the app's own withdrawal
// ledger for that wallet.
// Money OUT is our own ledger and always available. Money IN comes from the
// bank, so it can be missing while the rest is fine — half a history is more
// use than a 500, and the withdrawals half is the half we can always vouch for.
export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req)).catch(() => null);
  if (!acc) {
    return Response.json({ error: "I could not load your account just now. Try again in a moment." }, { status: 500 });
  }

  const outbound = await getWithdrawals(acc.id).catch(() => []);

  const provider = paymentProvider();

  // Not a failure, and not "no payments". BMONI publishes a wallet balance but
  // no wallet-level list of the credits behind it, so there is nothing
  // truthful to itemise. Returning [] would render as "No payments received
  // yet" — a claim that nobody has paid this worker, which is exactly the
  // thing they cannot check for themselves.
  if (!provider.canListInbound) {
    return Response.json({
      inbound: null,
      inboundUnavailable:
        "I can see your balance, but I cannot list the individual payments behind it yet. " +
        "Your balance above is the confirmed total.",
      outbound,
    });
  }

  try {
    const inbound = (await provider.listInbound(acc.id)).map((c) => ({
      amount: toNaira(c.amountKobo),
      status: "PAID",
      from: c.from ?? "Bank transfer",
      reference: c.reference,
      at: c.at,
    }));
    return Response.json({ inbound, outbound });
  } catch (e) {
    // Not an error the page should fail on: say what is missing and show the
    // rest. Never an empty list presented as "no payments" — that reads as
    // "nobody paid you", which is a different and much worse claim.
    return Response.json({ inbound: null, inboundUnavailable: spokenProviderError(e), outbound });
  }
}
