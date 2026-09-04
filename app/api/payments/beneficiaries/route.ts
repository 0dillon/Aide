import { getAccount, listBeneficiaries, saveBeneficiary } from "@/lib/store";
import { paymentProvider } from "@/lib/banking";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
// Saving a beneficiary name-enquiries it against the bank first.
export const maxDuration = 30;

// Saved withdrawal destinations for the signed-in user.
export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  return Response.json({ beneficiaries: await listBeneficiaries(acc.id) });
}

// Save one. The account is re-verified by name enquiry unless an accountName
// is supplied from an immediately preceding successful withdrawal.
export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const { accountNumber, bankCode, accountName, bankName } = (await req.json().catch(() => ({}))) as {
    accountNumber?: string;
    bankCode?: string;
    accountName?: string;
    bankName?: string;
  };
  if (!accountNumber?.trim() || !bankCode?.trim()) {
    return Response.json({ error: "accountNumber and bankCode are required." }, { status: 400 });
  }
  let name = accountName?.trim();
  if (!name) {
    try {
      name = (await paymentProvider().verifyDestination(acc.id, accountNumber.trim(), bankCode.trim())).accountName;
    } catch {
      return Response.json({ error: "Bank details not found — check the account number and bank." }, { status: 404 });
    }
  }
  const r = await saveBeneficiary(acc.id, { accountName: name, accountNumber: accountNumber.trim(), bankCode: bankCode.trim(), bankName });
  return Response.json({ ok: true, created: r.created, accountName: name });
}
