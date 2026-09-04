import { ethers } from "ethers";

// BMONI takes two signatures over the life of a wallet, made with OPPOSITE
// methods, and mixing them up is the failure mode the whole module guards.
//
//   owner proof (wallet creation) — challenge TEXT, WITH the EIP-191 prefix
//   proposal    (moving money)    — raw 32-byte DIGEST, WITHOUT it
//
// Signing a proposal the message way produces a signature that is structurally
// valid, decodes cleanly, carries a correct v byte, and is accepted and
// recorded by BMONI. It just recovers to a different address, never matches the
// proposal's signer snapshot, and the transfer silently never executes.
//
// That silence is why this matters here more than in most integrations. Aide
// would have every reason to tell a worker their wages were on the way, and no
// way to discover otherwise. A transfer that fails loudly costs a retry.
//
// BMONI has no endpoint that validates a signature without submitting it, so
// the published test vector in tests/money/bmoni-signing.test.ts is the only
// way to prove the toolchain before real money depends on it.

// A signature is 65 bytes: r (32) ‖ s (32) ‖ v (1), hex, 0x-prefixed.
const SIGNATURE_SHAPE = /^0x[0-9a-fA-F]{130}$/;

// Ethers already emits v as 27/28 and serializes r‖s‖v in order, so this is a
// tripwire rather than a fixup: if a future library change starts emitting
// yParity 0/1, BMONI answers "Invalid yParityOrV" from behind a network call
// and a proposal id. Better to fail here, with the bytes in hand.
function assertWellFormed(signature: string): string {
  if (!SIGNATURE_SHAPE.test(signature)) {
    throw new Error(`Malformed signature: expected 65 bytes as hex, got ${signature}`);
  }
  const v = parseInt(signature.slice(-2), 16);
  if (v !== 27 && v !== 28) {
    throw new Error(`Signature v byte is ${v}; BMONI expects the Ethereum convention of 27 or 28`);
  }
  return signature;
}

// Wallet creation, step 3: prove control of the owner address by signing the
// challenge text. signMessage applies the EIP-191 prefix, which is what this
// step wants — the opposite of signProposalDigest below.
export async function signOwnerProof(privateKey: string, challengeMessage: string): Promise<string> {
  return assertWellFormed(await new ethers.Wallet(privateKey).signMessage(challengeMessage));
}

// Moving money, step 11: sign the `hashToSign` from GET …/sign-payload as a
// raw digest. signingKey.sign, NOT signMessage — no EIP-191 prefix.
//
// Synchronous, and deliberately not dressed up as async: there is nothing to
// await, and a Promise here would suggest a round trip that does not happen.
export function signProposalDigest(privateKey: string, hashToSign: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashToSign)) {
    // Not a 32-byte digest. Signing it anyway would produce a valid-looking
    // signature over the wrong thing, which is the silent failure again.
    throw new Error(`Expected a 32-byte hex digest to sign, got ${hashToSign}`);
  }
  return assertWellFormed(new ethers.Wallet(privateKey).signingKey.sign(hashToSign).serialized);
}
