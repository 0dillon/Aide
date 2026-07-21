import { getAccount, setSecurityPhrase } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Set the worker's spoken security phrase — the accessible replacement for
// SMS OTP on withdrawals. Only the hash is stored, and only workers use it
// (employer withdrawals keep the per-withdrawal random word).
export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  if (acc.role !== "worker") {
    return Response.json({ error: "Only worker accounts use a spoken security phrase." }, { status: 403 });
  }
  const { phrase } = (await req.json().catch(() => ({}))) as { phrase?: string };
  const r = await setSecurityPhrase(acc.id, String(phrase ?? ""));
  if (!r.ok) return Response.json({ error: r.message }, { status: 400 });
  return Response.json({ ok: true });
}
