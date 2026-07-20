import { isValidWebhook, verifyTransaction } from "@/lib/monnify";
import { accountIdFromWalletReference, publishEvent } from "@/lib/store";

export const runtime = "nodejs";

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

  const body = JSON.parse(raw) as {
    eventType?: string;
    eventData?: {
      transactionReference?: string;
      customer?: { name?: string };
      product?: { type?: string; reference?: string };
    };
  };
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
