import { getAccount } from "@/lib/store";
import { paymentProvider } from "@/lib/banking";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
// Talks to the bank, which can be slow. The platform default is short enough
// to kill the request before our own timeout can report why it failed.
export const maxDuration = 30;

// Pure name enquiry for the inline validation UI: as the user fills in bank
// details, the form shows "Account found: NAME" or "Bank details not found"
// right under the fields. Nothing is saved here.
export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req)).catch(() => null);
  if (!acc) return Response.json({ error: "I could not load your account just now." }, { status: 500 });

  const { accountNumber, bankCode } = (await req.json().catch(() => ({}))) as {
    accountNumber?: string;
    bankCode?: string;
  };
  if (!accountNumber?.trim() || !bankCode?.trim()) {
    return Response.json({ error: "accountNumber and bankCode are required." }, { status: 400 });
  }
  try {
    // Through the seam: BMONI scopes name enquiry to the asking user, so this
    // is verified as the account that will be paying.
    const r = await paymentProvider().verifyDestination(acc.id, accountNumber.trim(), bankCode.trim());
    return Response.json({ ok: true, accountName: r.accountName, accountNumber: r.accountNumber });
  } catch {
    return Response.json({ ok: false, error: "Bank details not found — check the account number and bank." }, { status: 404 });
  }
}
