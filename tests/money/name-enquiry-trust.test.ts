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
// The decision is to surface whatever the provider says, so Aide behaves the
// same on the dev host as it will on production. The guard still exists and is
// still tested — it is opt-in behind BMONI_STRICT_NAME_ENQUIRY, so the day
// this points at a funded wallet it is one variable rather than a rewrite.

describe("by default, the provider's answer is taken as given", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("does not second-guess the development host", () => {
    // Aide will read "Ekon Orji" out loud for an account number nobody typed
    // correctly. On the sandbox that is harmless: no wallet holds money and no
    // persona is a real person.
    expect(isFabricatedNameEnquiry("bmoni", "https://embedded-dev.bmoni.com")).toBe(false);
  });

  it("does not second-guess an unknown host either", () => {
    expect(isFabricatedNameEnquiry("bmoni", undefined)).toBe(false);
  });
});

describe("with BMONI_STRICT_NAME_ENQUIRY turned on", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("BMONI_STRICT_NAME_ENQUIRY", "true");
  });

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

  it("distrusts an unknown host", () => {
    // "We cannot tell" must not resolve to "verified" once strictness is on.
    expect(isFabricatedNameEnquiry("bmoni", undefined)).toBe(true);
    expect(isFabricatedNameEnquiry("bmoni", "")).toBe(true);
  });
});

describe("what Aide says before money moves", () => {
  it("reads the name back when it was verified", () => {
    expect(destinationConfirmation({ accountName: "Jabo Samson Joe", accountNumber: "3463455722", nameVerified: true }))
      .toBe("to Jabo Samson Joe, account 3 4 6 3 4 5 5 7 2 2");
  });

  it("spells the digits even alongside a verified name", () => {
    // Accessibility rather than trust: "3463455722" reaches a screen reader as
    // "three billion, four hundred and sixty-three million…", which cannot be
    // checked against the number someone meant to type.
    expect(
      destinationConfirmation({ accountName: "Jabo Samson Joe", accountNumber: "3463455722", nameVerified: true }),
    ).toContain("3 4 6 3 4 5 5 7 2 2");
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
