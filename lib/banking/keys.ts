import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ethers } from "ethers";

// Per-user secp256k1 owner keys for BMONI smart wallets.
//
// Aide holds these keys itself. BMONI's own SDK would hold them in the Android
// Keystore or iOS Secure Enclave, but it also puts a 4-to-6 digit PIN on screen
// for every signature — the exact interaction the spoken security phrase exists
// to replace, and one a blind user cannot complete. Aide is a web app besides.
//
// That trade is deliberate, and the cost is that this key is ours to protect:
// whoever holds it can sign a transfer out of a worker's wallet. So it is
// encrypted before it goes near Convex, with AES-256-GCM — authenticated, so a
// tampered row fails loudly instead of decrypting to a *different* key. A
// different key would sign proposals that recover to an address BMONI does not
// recognise, which it accepts and records and never executes: the silent
// failure again, one layer down.

export type OwnerKey = { privateKey: string; address: string };

const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

// Read lazily. Importing this module must not break `npm run build`, which
// runs with no secrets by design — but a missing secret must never fall back
// to a default key, so this throws at use rather than defaulting.
function masterKey(): Buffer {
  const raw = process.env.BMONI_KEY_SECRET?.trim();
  if (!raw) {
    throw new Error(
      "Missing BMONI_KEY_SECRET. It encrypts every user's wallet owner key; there is deliberately no default.",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("BMONI_KEY_SECRET must be 32 bytes as 64 hex characters (openssl rand -hex 32).");
  }
  return Buffer.from(raw, "hex");
}

export function generateOwnerKey(): OwnerKey {
  const w = ethers.Wallet.createRandom();
  return { privateKey: w.privateKey, address: w.address };
}

// Layout: iv ‖ authTag ‖ ciphertext, base64. The random iv is what makes two
// seals of the same key differ — equal ciphertexts would reveal that two users
// share a key, and let a stolen row be replayed onto another.
export function sealPrivateKey(privateKey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const body = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function openPrivateKey(sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Sealed owner key is truncated or not a sealed value at all.");
  }
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  // final() throws if the tag does not verify — wrong secret, or tampering.
  const out = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  if (!/^0x[0-9a-fA-F]{64}$/.test(out)) {
    throw new Error("Sealed value did not decrypt to a private key.");
  }
  return out;
}
