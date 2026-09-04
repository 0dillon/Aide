import { describe, expect, it } from "vitest";
import { walletAlreadyExists } from "../../lib/banking/bmoni-wallet";

// The read-before-create guard.
//
// Smart-wallet creation has no uniqueness guard at BMONI, so a blind retry
// produces a SECOND wallet and deposits then route to whichever one we did not
// record. Before creating, we ask whether one already exists.
//
// The trap: the balances endpoint answers 400 when the user has no wallet —
// "No embedded smart wallet group found for this user. Call POST
// .../owner-proof-challenges first." That is the NORMAL state of a user about
// to get their first wallet, so the guard was throwing on the exact response
// that means "safe to proceed", and provisioning could never complete.
//
// It must read that one message as "no wallet", and everything else as
// "cannot tell" — which has to fail closed, because a network blip misread as
// "no wallet" is how a duplicate gets created.

describe("deciding whether a wallet already exists", () => {
  it("reads the documented no-wallet 400 as no wallet", () => {
    expect(
      walletAlreadyExists({
        ok: false,
        message: "BMONI 400: No embedded smart wallet group found for this user. Call POST .../owner-proof-challenges first.",
      }),
    ).toBe(false);
  });

  it("sees a wallet when balances come back with one", () => {
    expect(
      walletAlreadyExists({
        ok: true,
        body: { balances: [{ smartWalletId: "1e40b487", currency: "NGN", balance: "0", error: null }] },
      }),
    ).toBe(true);
  });

  it("reads an empty balances array as no wallet", () => {
    expect(walletAlreadyExists({ ok: true, body: { balances: [] } })).toBe(false);
  });

  it("fails closed on any other error", () => {
    // A timeout must never be read as "no wallet". That is how the second
    // wallet gets created, and deposits then land on the one we did not store.
    for (const message of ["fetch failed", "BMONI 500: upstream", "BMONI 401: bad key", "socket hang up"]) {
      expect(walletAlreadyExists({ ok: false, message })).toBe(true);
    }
  });

  it("fails closed on a body it cannot read", () => {
    expect(walletAlreadyExists({ ok: true, body: null })).toBe(true);
    expect(walletAlreadyExists({ ok: true, body: { unexpected: 1 } })).toBe(true);
  });
});
