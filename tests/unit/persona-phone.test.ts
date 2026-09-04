import { describe, expect, it } from "vitest";
import { personaPhone } from "../../lib/store/persona-phone";

// BMONI enforces global uniqueness on phoneNumber across every team sharing
// the development sandbox, and the two documented persona numbers
// (+2348000000000 and +2348000000001) are the first thing anyone reaches for.
// They are long gone: creating a user with one returns
// "409 User already exists with this phoneNumber", and because another team
// registered it under their own email, our conflict recovery correctly refuses
// to adopt it — binding a worker to a stranger's wallet is worse than failing.
//
// The phone is not part of identity matching. Verified against the sandbox: a
// user created with a generated number, the persona's real name, and the
// persona's BVN still completed start-nigeria and was issued a virtual account
// in the persona's name. Only the BVN and the name are matched.
//
// So the number just has to be well-formed, ours, and STABLE — a number that
// changed between calls would create a fresh BMONI user every time.

describe("the phone number a demo persona is registered with", () => {
  it("is a valid Nigerian E.164 number", () => {
    expect(personaPhone("demo-worker", "dep-1")).toMatch(/^\+234[789]\d{9}$/);
  });

  it("is stable for the same account and deployment", () => {
    // Instability here does not fail loudly — it silently creates a second
    // BMONI user, and wallet creation has no uniqueness guard behind it.
    expect(personaPhone("demo-worker", "dep-1")).toBe(personaPhone("demo-worker", "dep-1"));
  });

  it("differs between the worker and the employer", () => {
    expect(personaPhone("demo-worker", "dep-1")).not.toBe(personaPhone("demo-employer", "dep-1"));
  });

  it("differs between deployments, so two clones of this repo do not collide", () => {
    // The whole reason the documented numbers are unusable.
    expect(personaPhone("demo-worker", "dep-1")).not.toBe(personaPhone("demo-worker", "dep-2"));
  });

  it("never produces one of the documented persona numbers", () => {
    for (const dep of ["a", "b", "c", "dep-1", "anonymous:anonymous-agent"]) {
      expect(["+2348000000000", "+2348000000001"]).not.toContain(personaPhone("demo-worker", dep));
    }
  });
});
