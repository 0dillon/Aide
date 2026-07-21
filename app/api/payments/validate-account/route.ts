import { validateBankAccount } from "@/lib/monnify";

export const runtime = "nodejs";

// Pure name enquiry for the inline validation UI: as the user fills in bank
// details, the form shows "Account found: NAME" or "Bank details not found"
// right under the fields. Nothing is saved here.
export async function POST(req: Request) {
  const { accountNumber, bankCode } = (await req.json().catch(() => ({}))) as {
    accountNumber?: string;
    bankCode?: string;
  };
  if (!accountNumber?.trim() || !bankCode?.trim()) {
    return Response.json({ error: "accountNumber and bankCode are required." }, { status: 400 });
  }
  try {
    const r = await validateBankAccount(accountNumber.trim(), bankCode.trim());
    return Response.json({ ok: true, accountName: r.accountName, accountNumber: r.accountNumber });
  } catch {
    return Response.json({ ok: false, error: "Bank details not found — check the account number and bank." }, { status: 404 });
  }
}
