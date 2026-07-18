import { armWithdrawal } from "@/lib/store";
import { confirmWithdrawal } from "@/lib/payments";

export const runtime = "nodejs";

// Two-step, voice-confirmable withdrawal — the same gate the agent uses.
//   { action: "prepare", amount }        arms it and returns the confirm word
//   { action: "confirm", spokenPhrase }  verifies the word, then really transfers
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    amount?: number;
    spokenPhrase?: string;
  };

  if (body.action === "prepare") {
    const r = armWithdrawal(Number(body.amount));
    if (!r.ok) return Response.json({ error: r.message }, { status: 400 });
    return Response.json(r);
  }

  if (body.action === "confirm") {
    const r = await confirmWithdrawal(String(body.spokenPhrase ?? ""));
    if (!r.ok) return Response.json({ error: r.message }, { status: 400 });
    return Response.json(r);
  }

  return Response.json({ error: "action must be 'prepare' or 'confirm'." }, { status: 400 });
}
