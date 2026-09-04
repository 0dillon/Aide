import { describe, expect, it } from "vitest";
import { publicAccount } from "../../lib/store/accounts";
import type { Account } from "../../lib/store/state";

// publicAccount is the only shape of an account allowed to reach the browser.
// It gained new fields when BMONI provisioning needed a name split, a phone
// and a BVN — and a BVN is not a profile field. It is the identifier every
// Nigerian bank uses to tie a person to their accounts, it cannot be changed,
// and it is enough on its own to start an identity fraud.
//
// So this file exists to fail the moment a sensitive field is added to Account
// without a decision being made about whether it may be serialized.

const full: Account = {
  id: "demo-worker",
  name: "Bunch Dillon",
  role: "worker",
  email: "aide-demo-worker@aide.test",
  createdAt: 0,
  skills: [],
  bio: "",
  passwordHash: "$2b$10$notarealhash",
  firstName: "Bunch",
  lastName: "Dillon",
  phoneNumber: "+2348000000000",
  bvn: "95888168924",
};

describe("what an account may tell the browser", () => {
  it("never includes the BVN", () => {
    const pub = publicAccount(full) as Record<string, unknown>;
    expect(pub.bvn).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("95888168924");
  });

  it("never includes the password hash", () => {
    const pub = publicAccount(full) as Record<string, unknown>;
    expect(pub.passwordHash).toBeUndefined();
  });

  it("still carries the things the profile page renders", () => {
    const pub = publicAccount(full);
    expect(pub.name).toBe("Bunch Dillon");
    expect(pub.role).toBe("worker");
    expect(pub.authenticated).toBe(true);
  });

  it("keeps the fields the account holder is entitled to see about themselves", () => {
    // Their own name split and phone number are theirs; the BVN is the one
    // that stays server-side, because it is a credential rather than a detail.
    const pub = publicAccount(full) as Record<string, unknown>;
    expect(pub.firstName).toBe("Bunch");
    expect(pub.phoneNumber).toBe("+2348000000000");
  });
});
