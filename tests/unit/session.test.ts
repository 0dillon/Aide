import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, USER_COOKIE, clearSessionCookie, clearUserCookie, sessionCookie, userCookie, userIdFrom } from "../../lib/session";

// The signed session cookie is the only thing standing between "I am dillon"
// and "I am whoever I typed". It gates every money route, so forgery has to be
// impossible and expiry has to be enforced.

const asRequest = (cookie: string) => new Request("http://localhost/", { headers: { cookie } });
const valueOf = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");

describe("signed session cookies", () => {
  it("round-trips the account id it was issued for", () => {
    const cookie = `${SESSION_COOKIE}=${valueOf(sessionCookie("u-abc123"))}`;
    expect(userIdFrom(asRequest(cookie))).toBe("u-abc123");
  });

  it("is HttpOnly and SameSite, so script and cross-site cannot lift it", () => {
    const c = sessionCookie("u-abc123");
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
  });

  it("rejects a tampered account id", () => {
    // Swap the identity but keep the signature: the classic forgery attempt.
    const raw = decodeURIComponent(valueOf(sessionCookie("u-victim")));
    const [, exp, sig] = raw.split(":");
    const forged = encodeURIComponent(`u-attacker:${exp}:${sig}`);
    expect(userIdFrom(asRequest(`${SESSION_COOKIE}=${forged}`))).toBeUndefined();
  });

  it("rejects a tampered expiry", () => {
    const raw = decodeURIComponent(valueOf(sessionCookie("u-abc123")));
    const [id, , sig] = raw.split(":");
    const farFuture = Date.now() + 10 * 365 * 24 * 3600 * 1000;
    const forged = encodeURIComponent(`${id}:${farFuture}:${sig}`);
    expect(userIdFrom(asRequest(`${SESSION_COOKIE}=${forged}`))).toBeUndefined();
  });

  it("rejects a garbage signature", () => {
    const raw = decodeURIComponent(valueOf(sessionCookie("u-abc123")));
    const [id, exp] = raw.split(":");
    const forged = encodeURIComponent(`${id}:${exp}:${"0".repeat(64)}`);
    expect(userIdFrom(asRequest(`${SESSION_COOKIE}=${forged}`))).toBeUndefined();
  });

  it("rejects an expired session even when correctly signed", () => {
    // Signature valid, clock past it. Must not authenticate.
    const past = Date.now() - 1000;
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const secret = process.env.SESSION_SECRET || process.env.MONNIFY_SECRET_KEY || "aide-dev-secret";
    const payload = `u-abc123:${past}`;
    const sig = createHmac("sha256", secret).update(payload).digest("hex");
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(`${payload}:${sig}`)}`;
    expect(userIdFrom(asRequest(cookie))).toBeUndefined();
  });

  it("ignores a malformed cookie instead of throwing", () => {
    for (const junk of ["", "garbage", "a:b", "::::", "a:b:c:d:e"]) {
      expect(() => userIdFrom(asRequest(`${SESSION_COOKIE}=${encodeURIComponent(junk)}`))).not.toThrow();
    }
  });
});

describe("device identity cookie", () => {
  // This cookie used to be a bare `aide-user=<id>`, so identity was simply
  // whatever the client typed. Setting it to another account's id made you that
  // account, with no password and nothing else to get past. It is signed now,
  // and these tests exist to keep it that way.

  it("is honoured when it carries a valid signature", () => {
    const cookie = `${USER_COOKIE}=${valueOf(userCookie("demo-worker"))}`;
    expect(userIdFrom(asRequest(cookie))).toBe("demo-worker");
  });

  it("refuses a hand-written cookie naming an account", () => {
    // The whole attack: type someone else's id and become them.
    expect(userIdFrom(asRequest(`${USER_COOKIE}=demo-worker`))).toBeUndefined();
    expect(userIdFrom(asRequest(`${USER_COOKIE}=u-somebody-else`))).toBeUndefined();
  });

  it("refuses a signature lifted from a different account", () => {
    // Splicing another account's id onto a signature that was issued for this
    // one must not verify — the id is inside the signed payload.
    const mine = decodeURIComponent(valueOf(userCookie("u-mine")));
    const sig = mine.slice(mine.lastIndexOf(":") + 1);
    const exp = mine.split(":")[1];
    const spliced = encodeURIComponent(`u-victim:${exp}:${sig}`);
    expect(userIdFrom(asRequest(`${USER_COOKIE}=${spliced}`))).toBeUndefined();
  });

  it("loses to a valid signed session, so a real login cannot be downgraded", () => {
    const device = `${USER_COOKIE}=${valueOf(userCookie("demo-worker"))}`;
    const signed = `${SESSION_COOKIE}=${valueOf(sessionCookie("u-real"))}`;
    expect(userIdFrom(asRequest(`${device}; ${signed}`))).toBe("u-real");
  });

  it("is the fallback when the signed session fails verification", () => {
    // A forged session must not authenticate as its claimed id. Falling back to
    // a properly signed device cookie is the safe outcome.
    const forged = `${SESSION_COOKIE}=${encodeURIComponent("u-attacker:9999999999999:deadbeef")}`;
    const device = `${USER_COOKIE}=${valueOf(userCookie("demo-worker"))}`;
    expect(userIdFrom(asRequest(`${device}; ${forged}`))).toBe("demo-worker");
  });

  it("expires, so an abandoned device does not stay signed in forever", () => {
    const raw = decodeURIComponent(valueOf(userCookie("u-abc123")));
    const [id, , sig] = raw.split(":");
    const stale = encodeURIComponent(`${id}:${Date.now() - 1000}:${sig}`);
    expect(userIdFrom(asRequest(`${USER_COOKIE}=${stale}`))).toBeUndefined();
  });

  it("returns undefined when there are no cookies at all", () => {
    expect(userIdFrom(asRequest(""))).toBeUndefined();
  });

  it("ignores a malformed device cookie instead of throwing", () => {
    for (const junk of ["", "garbage", "a:b", "::::", "a:b:c:d:e"]) {
      expect(() => userIdFrom(asRequest(`${USER_COOKIE}=${encodeURIComponent(junk)}`))).not.toThrow();
    }
  });
});

describe("logout", () => {
  it("expires the session cookie immediately", () => {
    expect(clearSessionCookie()).toMatch(/Max-Age=0/);
  });

  it("expires the device cookie immediately", () => {
    expect(clearUserCookie()).toMatch(/Max-Age=0/);
  });

  it("issues a signed, HttpOnly device cookie for voice signup", () => {
    const c = userCookie("u-new");
    expect(c).toMatch(/^aide-user=/);
    expect(c).toMatch(/HttpOnly/);
    // The id must not sit in the cookie unsigned — that was the bug.
    expect(c).not.toMatch(/^aide-user=u-new;/);
    expect(userIdFrom(asRequest(`${USER_COOKIE}=${valueOf(c)}`))).toBe("u-new");
  });
});

describe("the signing key", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to sign anything in production without SESSION_SECRET", () => {
    // A default that ships in the repository is a default an attacker also
    // has, and with it they can mint a cookie for any account. Failing to boot
    // is the correct outcome; quietly signing with a known key is not.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => sessionCookie("u-abc123")).toThrow(/SESSION_SECRET/);
  });

  it("says how to fix it, since this fires at deploy time", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => sessionCookie("u-abc123")).toThrow(/randomBytes|environment variables/);
  });

  it("does not fall back to the payment provider's key", () => {
    // MONNIFY_SECRET_KEY used to stand in here. One leak should not cost both.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("MONNIFY_SECRET_KEY", "monnify-secret");
    expect(() => sessionCookie("u-abc123")).toThrow(/SESSION_SECRET/);
  });

  it("signs normally in production once the secret is set, and marks it Secure", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "a-real-secret-value");
    const cookie = sessionCookie("u-abc123");
    expect(cookie).toMatch(/Secure/);
    expect(userIdFrom(asRequest(`${SESSION_COOKIE}=${valueOf(cookie)}`))).toBe("u-abc123");
  });

  it("marks the device cookie Secure in production too", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "a-real-secret-value");
    expect(userCookie("u-abc123")).toMatch(/Secure/);
    expect(clearSessionCookie()).toMatch(/Secure/);
  });
});
