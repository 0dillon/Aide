import { getAccount } from "@/lib/store";
import { paymentProvider } from "@/lib/banking";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 30;

// The banks a withdrawal may be sent to, with the live provider's OWN codes.
//
// The page used to hardcode thirteen NIP codes. Those are Monnify's
// vocabulary: Wema is 035 there and 000017 at BMONI, and sending a NIP code to
// BMONI is not a soft failure — verified against the sandbox, name enquiry
// returns "We could not verify this account", so the withdrawal simply cannot
// be set up and the reason looks like a wrong account number.
export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req)).catch(() => null);
  if (!acc) return Response.json({ error: "I could not load your account just now." }, { status: 500 });

  try {
    const banks = await paymentProvider().listBanks(acc.id);
    // Alphabetical: this is a select someone scrolls, and BMONI returns 302
    // banks in its own order.
    banks.sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ banks });
  } catch (e) {
    // No fallback list. Guessing codes here is exactly the bug being fixed —
    // an unusable dropdown is recoverable, a dropdown of codes this provider
    // rejects sends people chasing an account number that was never wrong.
    return Response.json(
      { banks: null, error: `I could not load the list of banks just now. ${(e as Error).message}` },
      { status: 503 },
    );
  }
}
