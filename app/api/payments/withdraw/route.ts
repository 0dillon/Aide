import { armWithdrawal, getAccount } from "@/lib/store";
import { confirmWithdrawal } from "@/lib/payments";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Two-step, voice-confirmable withdrawal from the signed-in user's own
// wallet — the same gate the agent uses.
//   { action: "prepare", amount, accountNumber?, bankCode?, beneficiaryName? }
//       arms it — the destination can be a new (name-enquiry verified) account
//       or a saved beneficiary; returns the confirm mode (word vs the worker's
//       own security phrase).
//   { action: "confirm", spokenPhrase }  verifies, then really transfers
export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    amount?: number;
    spokenPhrase?: string;
    accountNumber?: string;
    bankCode?: string;
    beneficiaryName?: string;
  };

  if (body.action === "prepare") {
    const r = await armWithdrawal(acc.id, Number(body.amount), {
      accountNumber: body.accountNumber,
      bankCode: body.bankCode,
      beneficiaryName: body.beneficiaryName,
    });
    if (!r.ok) return Response.json({ error: r.message, needsSecurityPhrase: r.needsSecurityPhrase }, { status: 400 });
    return Response.json(r);
  }

  if (body.action === "confirm") {
    const r = await confirmWithdrawal(acc.id, String(body.spokenPhrase ?? ""));
    if (!r.ok) return Response.json({ error: r.message }, { status: 400 });
    return Response.json(r);
  }

  return Response.json({ error: "action must be 'prepare' or 'confirm'." }, { status: 400 });
}
