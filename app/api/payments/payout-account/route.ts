import { registerPayout } from "@/lib/payments";

export const runtime = "nodejs";

// Validate (name enquiry) and save the worker's withdrawal destination.
export async function POST(req: Request) {
  const { accountNumber, bankCode } = (await req.json().catch(() => ({}))) as {
    accountNumber?: string;
    bankCode?: string;
  };
  if (!accountNumber || !bankCode) {
    return Response.json({ error: "accountNumber and bankCode are required." }, { status: 400 });
  }
  const r = await registerPayout(accountNumber.trim(), bankCode.trim());
  if (!r.ok) return Response.json({ error: r.message }, { status: 400 });
  return Response.json(r);
}
