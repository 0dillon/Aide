import { createAccount, findAccountByEmail, getAccount, provisionWalletInBackground, publicAccount, type Role } from "@/lib/store";
import { hashPassword } from "@/lib/auth";
import { sessionCookie, userCookie, clearUserCookie, userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return Response.json(publicAccount(getAccount(userIdFrom(req))));
}

// Sign up. With a password → a real credentialed account (signed HttpOnly
// session). Without one (Aide's voice signup) → a passwordless demo identity.
export async function POST(req: Request) {
  const { name, role, email, password } = (await req.json().catch(() => ({}))) as {
    name?: string;
    role?: string;
    email?: string;
    password?: string;
  };
  if (!name?.trim()) return Response.json({ error: "A name is required." }, { status: 400 });
  if (role !== "worker" && role !== "employer") {
    return Response.json({ error: "Role must be 'worker' or 'employer'." }, { status: 400 });
  }

  if (password) {
    if (password.length < 8) return Response.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    if (!email?.trim() || !email.includes("@")) {
      return Response.json({ error: "A valid email is required to create a login." }, { status: 400 });
    }
    if (findAccountByEmail(email)) {
      return Response.json({ error: "An account with that email already exists. Try logging in." }, { status: 409 });
    }
    const acc = createAccount(name, role as Role, email.trim(), hashPassword(password));
    // Per Monnify's guidance, the wallet (dedicated reserved NUBAN) is minted
    // at signup — in the background, so signing up never waits on the API.
    provisionWalletInBackground(acc.id);
    const headers = new Headers();
    headers.append("Set-Cookie", sessionCookie(acc.id));
    headers.append("Set-Cookie", clearUserCookie());
    return Response.json(publicAccount(acc), { headers });
  }

  const acc = createAccount(name, role as Role, email?.trim() || undefined);
  provisionWalletInBackground(acc.id);
  return Response.json(publicAccount(acc), { headers: { "Set-Cookie": userCookie(acc.id) } });
}
