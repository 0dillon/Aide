import { createAccount, getAccount, type Role } from "@/lib/store";
import { userCookie, userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const acc = getAccount(userIdFrom(req));
  return Response.json(acc);
}

// Create a demo account (worker or employer) and sign the browser in.
export async function POST(req: Request) {
  const { name, role, email } = (await req.json().catch(() => ({}))) as {
    name?: string;
    role?: string;
    email?: string;
  };
  if (!name?.trim()) return Response.json({ error: "A name is required." }, { status: 400 });
  if (role !== "worker" && role !== "employer") {
    return Response.json({ error: "Role must be 'worker' or 'employer'." }, { status: 400 });
  }
  const acc = createAccount(name, role as Role, email?.trim() || undefined);
  return Response.json(acc, { headers: { "Set-Cookie": userCookie(acc.id) } });
}
