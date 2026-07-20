import { isValidWebhook, verifyTransaction } from "@/lib/monnify";
import { publishEvent } from "@/lib/store";

export const runtime = "nodejs";

// Monnify webhook receiver. Signature-checked (SHA-512 HMAC of the raw body),
// and the transaction is ALWAYS re-fetched server-side before anything is
// announced — a webhook payload alone is never trusted about money.
export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("monnify-signature") ?? undefined;
  if (!isValidWebhook(raw, signature)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(raw) as {
    eventType?: string;
    eventData?: { transactionReference?: string; customer?: { name?: string } };
  };
  const ref = body.eventData?.transactionReference;

  if (body.eventType === "SUCCESSFUL_TRANSACTION" && ref) {
    try {
      const t = await verifyTransaction(ref);
      if (t.paymentStatus === "PAID") {
        publishEvent({
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
