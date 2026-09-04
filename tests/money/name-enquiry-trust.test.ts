import { beforeEach, describe, expect, it, vi } from "vitest";
import { isFabricatedNameEnquiry, destinationConfirmation } from "../../lib/banking/name-enquiry";

// BMONI's sandbox does not perform name enquiry. It returns a plausible
// Nigerian name for ANY ten-digit number against ANY bank code, deterministic
// per number so repeated lookups agree with each other and look real.
// Measured on 2026-09-04 against embedded-dev.bmoni.com:
//
//   0123456789 / GTBANK -> "Ekon Orji"
//   1111111111 / GTBANK -> "Alika Alabi"
//   0000000000 / GTBANK -> "Amarachi Nwosu"
//   4534076021 / any of six different banks -> "Dillon Bunch" every time
//
// Aide reads the account holder's name back so the person paying can stop
// before the money moves. That check is the only one a blind user has, and
// against a fabricator it is worse than having none: it turns a mistyped
// account number into a confident "Sending ₦20,000 to Ekon Orji".
//
// So a fabricated name must never be presented as confirmation, and what is
// read back instead has to be something the user can actually check — the
// digits they typed.

describe("recognising an endpoint that cannot really verify a name", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("treats the BMONI development host as fabricating", () => {
    expect(isFabricatedNameEnquiry("bmoni", "https://embedded-dev.bmoni.com")).toBe(true);
  });

  it("treats any non-production BMONI host as fabricating", () => {
    // Sandbox, staging, test — all the same promise, which is none.
    for (const host of [
      "https://embedded-sandbox.bmoni.com",
      "https://embedded-staging.bmoni.com",
      "https://embedded-test.bmoni.com",
      "https://embedded-dev.bmoni.com/",
    ]) {
      expect(isFabricatedNameEnquiry("bmoni", host)).toBe(true);
    }
  });

  it("trusts the production BMONI host", () => {
    expect(isFabricatedNameEnquiry("bmoni", "https://embedded.bmoni.com")).toBe(false);
  });

  it("trusts Monnify, whose sandbox does real name enquiry", () => {
    // Monnify's sandbox rejects an account that does not exist, which is why
    // this check is specific to the provider rather than to "is this a sandbox".
    expect(isFabricatedNameEnquiry("monnify", "https://sandbox.monnify.com")).toBe(false);
  });

  it("defaults to distrust when the host is unknown", () => {
    // An unset base URL means we cannot tell. Claiming a name is verified when
    // we do not know is the failure this file exists to prevent.
    expect(isFabricatedNameEnquiry("bmoni", undefined)).toBe(true);
    expect(isFabricatedNameEnquiry("bmoni", "")).toBe(true);
  });
});

describe("what Aide says before money moves", () => {
  it("reads the name back when it was really verified", () => {
    expect(destinationConfirmation({ accountName: "Jabo Samson Joe", accountNumber: "3463455722", nameVerified: true }))
      .toBe("to Jabo Samson Joe, account 3463455722");
  });

  it("reads the digits back instead when the name was not verified", () => {
    // The account number is the thing the user supplied and can check. The
    // name is not.
    const said = destinationConfirmation({
      accountName: "Ekon Orji",
      accountNumber: "0123456789",
      nameVerified: false,
    });
    expect(said).toContain("0 1 2 3 4 5 6 7 8 9");
    expect(said).toMatch(/could not confirm/i);
  });

  it("never speaks an unverified name", () => {
    // The whole point. If "Ekon Orji" is said out loud at all, someone will
    // hear it as confirmation.
    const said = destinationConfirmation({
      accountName: "Ekon Orji",
      accountNumber: "0123456789",
      nameVerified: false,
    });
    expect(said).not.toContain("Ekon Orji");
  });

  it("spaces the digits so they are heard one at a time", () => {
    // "0123456789" is read by a screen reader as a single huge number. Digits
    // separated are what makes a mistyped one audible.
    expect(
      destinationConfirmation({ accountName: "x", accountNumber: "3463455722", nameVerified: false }),
    ).toContain("3 4 6 3 4 5 5 7 2 2");
  });
});
