import { findAccountByEmail, publicAccount } from "@/lib/store";
import { verifyPassword } from "@/lib/auth";
import { sessionCookie, clearUserCookie } from "@/lib/session";

export const runtime = "nodejs";

// Real login: email + password against the stored scrypt hash. The error is
// deliberately identical for unknown email and wrong password.
export async function POST(req: Request) {
  const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    return Response.json({ error: "Email and password are required." }, { status: 400 });
  }
  const acc = findAccountByEmail(email);
  if (!acc?.passwordHash || !verifyPassword(password, acc.passwordHash)) {
    return Response.json({ error: "Invalid email or password." }, { status: 401 });
  }
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie(acc.id));
  headers.append("Set-Cookie", clearUserCookie());
  return Response.json(publicAccount(acc), { headers });
}
