import { createHmac, timingSafeEqual } from "node:crypto";

// Two kinds of identity, BOTH signed:
//  - aide-session: HttpOnly — real users who logged in with a password.
//  - aide-user: the device's chosen account, for the passwordless demo
//    accounts and for switching between accounts by voice.
// The signed session always wins when both are present.
//
// aide-user used to be a bare `aide-user=<id>`, which meant identity was
// whatever the client typed: setting the cookie to somebody else's account id
// made you that account, and no password, session, or route check stood in the
// way. It carries the same HMAC as the login session now. It still confers a
// weaker identity — no password was ever presented — but it can no longer be
// forged, only replayed by whoever already holds the cookie.

export const USER_COOKIE = "aide-user";
export const SESSION_COOKIE = "aide-session";

// Signing key. There is deliberately no baked-in fallback in production: a
// default that ships in the repository is a default an attacker also has, and
// with it they can mint a valid cookie for any account on the platform. Better
// to refuse to start than to run with a key everybody knows.
//
// MONNIFY_SECRET_KEY used to stand in here. Reusing a payment provider's
// credential as a cookie-signing key means one leak costs both, so it is gone
// even though it would have been unguessable.
const DEV_SECRET = "aide-dev-secret-not-for-production";
function signingKey(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is not set. It signs the cookies that decide who a request is, " +
        "so without it anyone can forge a session for any account. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` and set it " +
        "in your deployment's environment variables.",
    );
  }
  return DEV_SECRET;
}

const SESSION_TTL_S = 30 * 24 * 3600;
const DEVICE_TTL_S = 365 * 24 * 3600;

// Cookies must not travel in clear text — they are bearer tokens for an
// account that can move money. Omitted in development so http://localhost
// still works. Read per call rather than once at import, so it cannot be
// frozen to the wrong value by whatever happened to import this module first.
function secure(): string {
  return process.env.NODE_ENV === "production" ? " Secure;" : "";
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("hex");
}

// "<id>:<expiryMs>:<hmac>" — the same shape for both cookies.
function signedValue(id: string, ttlSeconds: number): string {
  const payload = `${id}:${Date.now() + ttlSeconds * 1000}`;
  return encodeURIComponent(`${payload}:${sign(payload)}`);
}

// Returns the id only if the signature is intact and the value has not expired.
function verifySigned(raw: string): string | undefined {
  const value = decodeURIComponent(raw);
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) return undefined;
  const payload = value.slice(0, lastColon);
  const sig = value.slice(lastColon + 1);
  const [id, exp] = payload.split(":");
  if (!id || !exp || !sig || !(Number(exp) > Date.now())) return undefined;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a forged cookie is attacker-controlled input.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return id;
}

export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${signedValue(id, SESSION_TTL_S)}; Path=/; HttpOnly;${secure()} SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure()} SameSite=Lax; Max-Age=0`;
}

// HttpOnly as well: nothing in the browser reads this, and script that can read
// it is script that can steal the account.
export function userCookie(id: string): string {
  return `${USER_COOKIE}=${signedValue(id, DEVICE_TTL_S)}; Path=/; HttpOnly;${secure()} SameSite=Lax; Max-Age=${DEVICE_TTL_S}`;
}

export function clearUserCookie(): string {
  return `${USER_COOKIE}=; Path=/; HttpOnly;${secure()} SameSite=Lax; Max-Age=0`;
}

function cookieValue(cookie: string, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1];
}

export function userIdFrom(req: Request): string | undefined {
  const cookie = req.headers.get("cookie") ?? "";

  const session = cookieValue(cookie, SESSION_COOKIE);
  if (session) {
    const id = verifySigned(session);
    if (id) return id;
  }

  const device = cookieValue(cookie, USER_COOKIE);
  if (device) return verifySigned(device);

  return undefined;
}
