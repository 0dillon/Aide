import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, USER_COOKIE, clearSessionCookie, sessionCookie, userCookie, userIdFrom } from "../../lib/session";

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

describe("demo identity cookie", () => {
  it("is used when no signed session is present", () => {
    expect(userIdFrom(asRequest(`${USER_COOKIE}=demo-worker`))).toBe("demo-worker");
  });

  it("loses to a valid signed session, so a real login cannot be downgraded", () => {
    const signed = `${SESSION_COOKIE}=${valueOf(sessionCookie("u-real"))}`;
    const both = `${USER_COOKIE}=demo-worker; ${signed}`;
    expect(userIdFrom(asRequest(both))).toBe("u-real");
  });

  it("is the fallback when the signed session fails verification", () => {
    // A forged session must not authenticate as its claimed id — dropping back
    // to the demo identity is the safe outcome.
    const forged = `${SESSION_COOKIE}=${encodeURIComponent("u-attacker:9999999999999:deadbeef")}`;
    const both = `${USER_COOKIE}=demo-worker; ${forged}`;
    expect(userIdFrom(asRequest(both))).toBe("demo-worker");
  });

  it("returns undefined when there are no cookies at all", () => {
    expect(userIdFrom(asRequest(""))).toBeUndefined();
  });
});

describe("logout", () => {
  it("expires the session cookie immediately", () => {
    expect(clearSessionCookie()).toMatch(/Max-Age=0/);
  });

  it("issues a readable demo cookie for voice signup", () => {
    expect(userCookie("u-new")).toMatch(/^aide-user=u-new;/);
  });
});
