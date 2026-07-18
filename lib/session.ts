// Demo session: the signed-in account id rides in a plain cookie. No tokens,
// no passwords — this is a hackathon identity, not an auth system.

export const USER_COOKIE = "aide-user";

export function userIdFrom(req: Request): string | undefined {
  const cookie = req.headers.get("cookie") ?? "";
  return /(?:^|;\s*)aide-user=([^;]+)/.exec(cookie)?.[1];
}

export function userCookie(id: string): string {
  return `${USER_COOKIE}=${id}; Path=/; SameSite=Lax; Max-Age=31536000`;
}
