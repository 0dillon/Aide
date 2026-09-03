import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { signOwnerProof, signProposalDigest } from "../../lib/banking/signing";

// BMONI takes two signatures and they are made with OPPOSITE methods. Owner
// proof signs challenge text WITH the EIP-191 prefix; a proposal signs a raw
// 32-byte digest WITHOUT it.
//
// Getting the proposal one wrong is the failure this file exists to prevent,
// and it is nasty: the signature is structurally valid, decodes cleanly, has a
// correct v byte, and is ACCEPTED and RECORDED. It simply recovers to a
// different address, so it never matches the proposal's signer snapshot and
// the transfer silently never executes. BMONI has no endpoint that validates a
// signature without submitting it, so this vector is the only way to know our
// toolchain is right before real money depends on it.
//
// For Aide the silent part is what matters. A transfer that fails loudly is
// recoverable; one that is accepted and never runs means Aide told a worker
// their wages were sent, truthfully as far as it could tell, and they were not.
//
// Values are BMONI's published vector, regenerable from scratch: the digest is
// keccak256 of the preimage below, and the key is the well-known public Anvil
// test account, which holds nothing and must never be used for anything else.
const PREIMAGE = "bmoni-embedded:BKE-2041:sign-payload-example";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const HASH_TO_SIGN = "0x8f5156823a5c2cdc7bedc12253e49e4946c6fff0273034eb485750035d21ad31";
const EXPECTED_SIGNATURE =
  "0x628f1aff48c9d1f35d45a735eb026db0437c5ed334a94dc7fb0ac86ca32c10bd" +
  "173a653a7f064c4512244f6fcbefb07e13bfe7368fcacdcc4e6fb153f50050991b";
// Where the WRONG method's signature recovers to. Published by BMONI precisely
// because the failure is otherwise invisible.
const WRONG_METHOD_ADDRESS = "0xC69f336bb0C1e391a97861cC1837e1f10a9Ba041";
// There are actually TWO wrong ways, and BMONI documents only the first.
// signMessage(getBytes(hash)) prefixes the 32 raw bytes and gives the address
// above; signMessage(hash) treats the "0x…" string as UTF-8 text and gives
// this one. Both are structurally valid and both silently never execute, so
// both are pinned here.
const WRONG_METHOD_AS_TEXT_ADDRESS = "0x5e474E09C62E717AEBe0e307c3285351442C1167";

describe("the vector itself", () => {
  it("regenerates BMONI's digest from the preimage", () => {
    // If this drifts, the vector below is not testing what it claims to.
    expect(ethers.keccak256(ethers.toUtf8Bytes(PREIMAGE))).toBe(HASH_TO_SIGN);
  });

  it("uses a key that really is the published Anvil account", () => {
    expect(new ethers.Wallet(ANVIL_KEY).address).toBe(OWNER_ADDRESS);
  });
});

describe("signing a proposal — the signature that moves money", () => {
  it("produces the exact bytes BMONI expects", async () => {
    expect(await signProposalDigest(ANVIL_KEY, HASH_TO_SIGN)).toBe(EXPECTED_SIGNATURE);
  });

  it("recovers to the registered owner, which is what the backend checks", async () => {
    const sig = await signProposalDigest(ANVIL_KEY, HASH_TO_SIGN);
    expect(ethers.recoverAddress(HASH_TO_SIGN, sig)).toBe(OWNER_ADDRESS);
  });

  it("does NOT recover to either address the message-signing method gives", async () => {
    // The whole point. A signature recovering to either of these is accepted
    // and recorded, and the money never moves.
    const sig = await signProposalDigest(ANVIL_KEY, HASH_TO_SIGN);
    const recovered = ethers.recoverAddress(HASH_TO_SIGN, sig);
    expect(recovered).not.toBe(WRONG_METHOD_ADDRESS);
    expect(recovered).not.toBe(WRONG_METHOD_AS_TEXT_ADDRESS);
  });

  it("refuses anything that is not a 32-byte digest", () => {
    // A sign-payload response that arrived empty, truncated, or as an object
    // would otherwise be signed as text: a valid signature over the wrong
    // thing, which fails the same silent way.
    expect(() => signProposalDigest(ANVIL_KEY, "not-a-digest")).toThrow(/32-byte hex digest/);
    expect(() => signProposalDigest(ANVIL_KEY, "0x8f5156")).toThrow(/32-byte hex digest/);
  });

  it("is 65 bytes with an Ethereum-convention v byte", async () => {
    const sig = await signProposalDigest(ANVIL_KEY, HASH_TO_SIGN);
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect([27, 28]).toContain(parseInt(sig.slice(-2), 16));
  });
});

describe("signing the owner-proof challenge — the opposite method", () => {
  it("applies the EIP-191 prefix, so it recovers under verifyMessage", async () => {
    const message = "prove you control this address";
    const sig = await signOwnerProof(ANVIL_KEY, message);
    expect(ethers.verifyMessage(message, sig)).toBe(OWNER_ADDRESS);
  });

  it("is not interchangeable with the proposal signature", async () => {
    // Same key, same input, deliberately different bytes. If these two ever
    // agree, one of them is using the wrong method.
    const asProof = await signOwnerProof(ANVIL_KEY, HASH_TO_SIGN);
    const asProposal = signProposalDigest(ANVIL_KEY, HASH_TO_SIGN);
    expect(asProof).not.toBe(asProposal);
  });

  it("reproduces both documented wrong paths, so the trap stays described", async () => {
    // Not testing our code — testing that the two failure addresses above are
    // still what these mistakes produce. If ethers ever changed how it treats
    // a string vs bytes, the comments here would quietly stop being true.
    const wallet = new ethers.Wallet(ANVIL_KEY);
    expect(ethers.recoverAddress(HASH_TO_SIGN, await wallet.signMessage(ethers.getBytes(HASH_TO_SIGN)))).toBe(
      WRONG_METHOD_ADDRESS,
    );
    expect(ethers.recoverAddress(HASH_TO_SIGN, await wallet.signMessage(HASH_TO_SIGN))).toBe(
      WRONG_METHOD_AS_TEXT_ADDRESS,
    );
  });
});
