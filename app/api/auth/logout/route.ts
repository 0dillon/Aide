import { clearSessionCookie, clearUserCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function POST() {
  const headers = new Headers();
  headers.append("Set-Cookie", clearSessionCookie());
  headers.append("Set-Cookie", clearUserCookie());
  return Response.json({ ok: true }, { headers });
}
