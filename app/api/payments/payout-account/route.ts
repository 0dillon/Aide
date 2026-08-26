import { registerPayout } from "@/lib/payments";
import { getAccount } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
// Talks to the bank, which can be slow. The platform default is short enough
// to kill the request before our own timeout can report why it failed.
export const maxDuration = 30;

// Validate (name enquiry) and save the signed-in user's withdrawal destination.
export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const { accountNumber, bankCode } = (await req.json().catch(() => ({}))) as {
    accountNumber?: string;
    bankCode?: string;
  };
  if (!accountNumber || !bankCode) {
    return Response.json({ error: "accountNumber and bankCode are required." }, { status: 400 });
  }
  const r = await registerPayout(acc.id, accountNumber.trim(), bankCode.trim());
  if (!r.ok) return Response.json({ error: r.message }, { status: 400 });
  return Response.json(r);
}
