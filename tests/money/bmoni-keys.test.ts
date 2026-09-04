import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Aide holds the owner key for every user's BMONI smart wallet, because the
// alternative — BMONI's SDK — puts a 4-to-6 digit PIN on screen for every
// signature, which is the exact interaction the spoken security phrase exists
// to replace. That trade is deliberate, and it means the key is ours to
// protect: whoever holds it can sign a transfer.
//
// So the private key must never sit in Convex in a form that is useful to
// anyone who reads the table. Encrypted at rest, authenticated so tampering is
// detected rather than silently producing a different key, and useless without
// a secret that lives only in the environment.

const SECRET = "0".repeat(64); // 32 bytes of hex — a test master key, not a real one
const OTHER_SECRET = "f".repeat(64);

let keys: typeof import("../../lib/banking/keys");

beforeEach(async () => {
  vi.resetModules();
  process.env.BMONI_KEY_SECRET = SECRET;
  keys = await import("../../lib/banking/keys");
});

describe("generating an owner key", () => {
  it("produces a usable secp256k1 key whose address matches", () => {
    const k = keys.generateOwnerKey();
    expect(k.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(new ethers.Wallet(k.privateKey).address).toBe(k.address);
  });

  it("never repeats a key", () => {
    const seen = new Set(Array.from({ length: 50 }, () => keys.generateOwnerKey().privateKey));
    expect(seen.size).toBe(50);
  });
});

describe("protecting the key at rest", () => {
  it("round-trips through seal and open", () => {
    const { privateKey } = keys.generateOwnerKey();
    expect(keys.openPrivateKey(keys.sealPrivateKey(privateKey))).toBe(privateKey);
  });

  it("does not leave the key readable in what it stores", () => {
    const { privateKey } = keys.generateOwnerKey();
    const sealed = keys.sealPrivateKey(privateKey);
    // The bare key must not be recoverable by reading the row, in hex or as
    // any trivial re-encoding of it.
    expect(sealed).not.toContain(privateKey);
    expect(sealed).not.toContain(privateKey.slice(2));
    expect(Buffer.from(sealed, "base64").toString("utf8")).not.toContain(privateKey.slice(2, 20));
  });

  it("seals the same key differently every time", () => {
    // Otherwise equal ciphertexts reveal that two users share a key, and a
    // stolen ciphertext can be replayed onto another row.
    const { privateKey } = keys.generateOwnerKey();
    expect(keys.sealPrivateKey(privateKey)).not.toBe(keys.sealPrivateKey(privateKey));
  });

  it("refuses a tampered value instead of returning a different key", async () => {
    // A silently-different key would sign proposals that recover to an address
    // BMONI does not recognise — accepted, recorded, never executed.
    const { privateKey } = keys.generateOwnerKey();
    const sealed = keys.sealPrivateKey(privateKey);
    const raw = Buffer.from(sealed, "base64");
    raw[raw.length - 1] ^= 0xff;
    expect(() => keys.openPrivateKey(raw.toString("base64"))).toThrow();
  });

  it("is useless without the right secret", async () => {
    const { privateKey } = keys.generateOwnerKey();
    const sealed = keys.sealPrivateKey(privateKey);
    vi.resetModules();
    process.env.BMONI_KEY_SECRET = OTHER_SECRET;
    const other = await import("../../lib/banking/keys");
    expect(() => other.openPrivateKey(sealed)).toThrow();
  });

  it("refuses to run at all without a secret configured", async () => {
    vi.resetModules();
    delete process.env.BMONI_KEY_SECRET;
    const bare = await import("../../lib/banking/keys");
    // Lazily, so importing this module cannot break a build that has no
    // secrets — but never by falling back to a default key.
    expect(() => bare.sealPrivateKey("0x" + "1".repeat(64))).toThrow(/BMONI_KEY_SECRET/);
  });
});
