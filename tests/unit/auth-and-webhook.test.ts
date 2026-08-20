import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../lib/auth";
import { isValidWebhook } from "../../lib/monnify";

// Two small modules where a subtle regression is invisible in normal use and
// catastrophic in the one case that matters.

describe("password hashing", () => {
  it("never stores the password itself", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored).not.toContain("correct horse battery staple");
  });

  it("accepts the right password", () => {
    expect(verifyPassword("s3cret-password", hashPassword("s3cret-password"))).toBe(true);
  });

  it("rejects the wrong password", () => {
    expect(verifyPassword("wrong-password", hashPassword("s3cret-password"))).toBe(false);
  });

  it("salts, so the same password hashes differently every time", () => {
    // Without this, identical passwords are visibly identical in the database.
    expect(hashPassword("same-password")).not.toBe(hashPassword("same-password"));
  });

  it("rejects a near-miss rather than matching on a prefix", () => {
    const stored = hashPassword("password123");
    expect(verifyPassword("password12", stored)).toBe(false);
    expect(verifyPassword("password1234", stored)).toBe(false);
    expect(verifyPassword("Password123", stored)).toBe(false);
  });

  it("returns false for a malformed stored value instead of throwing", () => {
    for (const junk of ["", "nosalt", ":", "abc:", ":def", "a:b:c"]) {
      expect(() => verifyPassword("x", junk)).not.toThrow();
      expect(verifyPassword("x", junk)).toBe(false);
    }
  });
});

describe("payment webhook signature", () => {
  // The webhook is how the platform learns money arrived. An unsigned or
  // forged one must never be believed — anyone can POST to a public URL.
  const secret = process.env.MONNIFY_SECRET_KEY as string;
  const sign = (body: string) => createHmac("sha512", secret).update(body).digest("hex");
  const body = JSON.stringify({ eventType: "SUCCESSFUL_TRANSACTION", eventData: { transactionReference: "TX-1" } });

  it("accepts a correctly signed payload", () => {
    expect(isValidWebhook(body, sign(body))).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(isValidWebhook(body, undefined)).toBe(false);
  });

  it("rejects a wrong signature", () => {
    expect(isValidWebhook(body, "0".repeat(128))).toBe(false);
  });

  it("rejects a payload altered after signing", () => {
    // Same signature, bigger amount — the attack this check exists to stop.
    const signature = sign(body);
    const tampered = body.replace("TX-1", "TX-2");
    expect(isValidWebhook(tampered, signature)).toBe(false);
  });

  it("refuses an oversized body rather than hashing it", () => {
    const huge = "x".repeat(512 * 1024 + 1);
    expect(isValidWebhook(huge, sign(huge))).toBe(false);
  });
});
