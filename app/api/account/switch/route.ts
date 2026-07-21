import { getAccount, hasAccount, listAccounts } from "@/lib/store";
import { userCookie, clearSessionCookie, userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Demo-identity switcher. Only passwordless demo accounts are listed or
// switchable — real credentialed users log in with email and password, and
// never appear in this list.
export async function GET(req: Request) {
  const current = await getAccount(userIdFrom(req));
  return Response.json({
    current: current.id,
    authenticated: !!current.passwordHash,
    accounts: (await listAccounts())
      .filter((a) => !a.passwordHash)
      .map((a) => ({ id: a.id, name: a.name, role: a.role })),
  });
}

export async function POST(req: Request) {
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id || !(await hasAccount(id))) return Response.json({ error: "No account with that id." }, { status: 400 });
  const acc = await getAccount(id);
  if (acc.passwordHash) {
    return Response.json({ error: "That account requires logging in with email and password." }, { status: 403 });
  }
  const headers = new Headers();
  headers.append("Set-Cookie", userCookie(acc.id));
  headers.append("Set-Cookie", clearSessionCookie()); // demo switch ends any real login
  return Response.json({ ok: true, id: acc.id, name: acc.name, role: acc.role }, { headers });
}
