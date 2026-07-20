import { createHmac, timingSafeEqual } from "node:crypto";

// Two kinds of identity:
//  - aide-session: signed, HttpOnly — real users who logged in with a password.
//  - aide-user: plain demo cookie — the seeded passwordless demo accounts.
// The signed session always wins when both are present.

export const USER_COOKIE = "aide-user";
export const SESSION_COOKIE = "aide-session";

const SECRET = process.env.SESSION_SECRET || process.env.MONNIFY_SECRET_KEY || "aide-dev-secret";
const SESSION_TTL_S = 30 * 24 * 3600;

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

// Signed login session: "<id>:<expiryMs>:<hmac>".
export function sessionCookie(id: string): string {
  const exp = Date.now() + SESSION_TTL_S * 1000;
  const payload = `${id}:${exp}`;
  return `${SESSION_COOKIE}=${encodeURIComponent(`${payload}:${sign(payload)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function userCookie(id: string): string {
  return `${USER_COOKIE}=${id}; Path=/; SameSite=Lax; Max-Age=31536000`;
}

export function clearUserCookie(): string {
  return `${USER_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}

export function userIdFrom(req: Request): string | undefined {
  const cookie = req.headers.get("cookie") ?? "";

  const raw = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie)?.[1];
  if (raw) {
    const value = decodeURIComponent(raw);
    const lastColon = value.lastIndexOf(":");
    const payload = value.slice(0, lastColon);
    const sig = value.slice(lastColon + 1);
    const [id, exp] = payload.split(":");
    if (id && exp && sig && Number(exp) > Date.now()) {
      const expected = sign(payload);
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) return id;
    }
  }

  return new RegExp(`(?:^|;\\s*)${USER_COOKIE}=([^;]+)`).exec(cookie)?.[1];
}
