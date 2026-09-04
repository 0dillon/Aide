import { isValidWebhook, verifyTransaction } from "@/lib/monnify";
import { accountIdFromWalletReference, publishEvent } from "@/lib/store";

export const runtime = "nodejs";
// Talks to the bank, which can be slow. The platform default is short enough
// to kill the request before our own timeout can report why it failed.
export const maxDuration = 30;

// MONNIFY ONLY. This route is inert when BMONI is the live provider — nothing
// at BMONI posts here, and no signature it sent would verify. Arrivals on
// BMONI reach the user through the poller in lib/store/events.ts, which reads
// the wallet's own transaction history through the seam. Do not read a quiet
// log here as "no money has arrived".
//
// Monnify webhook receiver. Signature-checked (SHA-512 HMAC of the raw body),
// and the transaction is ALWAYS re-fetched server-side before anything is
// announced — a webhook payload alone is never trusted about money. The
// event is delivered only to the wallet that was actually paid, resolved
// from the reserved account's reference in the payload.
export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("monnify-signature") ?? undefined;
  if (!isValidWebhook(raw, signature)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(raw) as {
      eventType?: string;
      eventData?: {
        transactionReference?: string;
        customer?: { name?: string };
        product?: { type?: string; reference?: string };
      };
    };
  } catch (e) {
    return Response.json({ error: "invalid json payload" }, { status: 400 });
  }
  const ref = body.eventData?.transactionReference;
  const accountId = accountIdFromWalletReference(body.eventData?.product?.reference ?? "");

  if (body.eventType === "SUCCESSFUL_TRANSACTION" && ref && accountId) {
    try {
      const t = await verifyTransaction(ref);
      if (t.paymentStatus === "PAID") {
        publishEvent(accountId, {
          type: "payment",
          amount: t.amountPaid,
          from: body.eventData?.customer?.name ?? "a bank transfer",
          reference: ref,
        });
      }
    } catch {
      /* verification failed — announce nothing */
    }
  }
  return Response.json({ ok: true });
}
