import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";

// These run the REAL Convex handlers against an in-memory database, so what is
// asserted here is the code that actually authorizes payments — not a stand-in.
//
// This is the sharpest edge in the product. A worker confirms a withdrawal by
// speaking, in a room where anyone present can hear the confirmation. The
// guarantees below are what make that safe: a confirmation authorizes exactly
// one transfer, a wrong attempt costs nothing, and a stale one is dead.
const modules = import.meta.glob("../../convex/**/*.ts");

const setup = async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.wallets.ensure, { accountId: "u-worker", accountReference: "aide-u-worker" });
  return t;
};

const arm = (t: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) =>
  t.mutation(api.wallets.armPending, {
    accountId: "u-worker",
    amountKobo: 500_000,
    phrase: "mango",
    mode: "word" as const,
    destAccount: "0123456789",
    destBankCode: "058",
    destAccountName: "ADA OKAFOR",
    createdAt: Date.now(),
    ...over,
  });

const consume = (t: Awaited<ReturnType<typeof setup>>, spoken: string, over: Record<string, unknown> = {}) =>
  t.mutation(api.wallets.consumePending, {
    accountId: "u-worker",
    spokenPhrase: spoken,
    now: Date.now(),
    ttlMs: 5 * 60 * 1000,
    ...over,
  });

describe("withdrawal confirmation — the double-spend gate", () => {
  it("authorizes the transfer when the spoken word matches", async () => {
    const t = await setup();
    await arm(t);
    const r = await consume(t, "mango");
    expect(r.ok).toBe(true);
    expect(r.ok && r.amountKobo).toBe(500_000);
    expect(r.ok && r.payoutAccount).toBe("0123456789");
  });

  it("CANNOT be consumed twice — one confirmation, one transfer", async () => {
    // The whole point of doing check-and-clear in a single mutation. If this
    // ever regresses, a repeated confirmation sends the money again.
    const t = await setup();
    await arm(t);
    const first = await consume(t, "mango");
    const second = await consume(t, "mango");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toBe("none");
  });

  it("survives two confirmations racing each other", async () => {
    // Same word, both in flight. Exactly one may win.
    const t = await setup();
    await arm(t);
    const results = await Promise.all([consume(t, "mango"), consume(t, "mango"), consume(t, "mango")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("accepts the word inside a whole spoken sentence", async () => {
    // People do not answer with a bare token; they say "the word is mango".
    const t = await setup();
    await arm(t);
    expect((await consume(t, "I think the word is mango, yes")).ok).toBe(true);
  });

  it("rejects a wrong word WITHOUT burning the pending withdrawal", async () => {
    // A misheard word must cost a retry, not the whole withdrawal — otherwise
    // speech recognition errors become lost money.
    const t = await setup();
    await arm(t);
    const bad = await consume(t, "banana");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toBe("mismatch");
    expect((await consume(t, "mango")).ok).toBe(true);
  });

  it("refuses a confirmation when nothing is armed", async () => {
    const t = await setup();
    const r = await consume(t, "mango");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("none");
  });

  it("expires a stale confirmation and clears it", async () => {
    // A withdrawal left armed must not stay live indefinitely.
    const t = await setup();
    await arm(t, { createdAt: Date.now() - 10 * 60 * 1000 });
    const r = await consume(t, "mango");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("expired");
    // ...and it is gone, not merely refused this once.
    expect((await consume(t, "mango", { now: Date.now() })).ok).toBe(false);
  });
});

describe("worker passphrase mode — the accessible replacement for an SMS code", () => {
  const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");
  // The server hashes every contiguous word-window of what was spoken, so
  // "my phrase is sunny garden gate" still matches a stored "sunny garden gate".
  const windowsOf = (spoken: string) => {
    const words = spoken.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    const out = new Set<string>();
    for (let len = 1; len <= Math.min(words.length, 8); len++) {
      for (let i = 0; i + len <= words.length; i++) out.add(hashOf(words.slice(i, i + len).join(" ")));
    }
    return [...out];
  };

  const armPassphrase = async () => {
    const t = await setup();
    await t.mutation(api.wallets.setSecurityPhrase, {
      accountId: "u-worker",
      accountReference: "aide-u-worker",
      hash: hashOf("sunny garden gate"),
    });
    await arm(t, { mode: "passphrase" as const });
    return t;
  };

  it("accepts the phrase spoken on its own", async () => {
    const t = await armPassphrase();
    expect((await consume(t, "sunny garden gate", { candidateHashes: windowsOf("sunny garden gate") })).ok).toBe(true);
  });

  it("accepts the phrase embedded in a sentence", async () => {
    const spoken = "okay my security phrase is sunny garden gate";
    const t = await armPassphrase();
    expect((await consume(t, spoken, { candidateHashes: windowsOf(spoken) })).ok).toBe(true);
  });

  it("ignores case and punctuation, since this arrives via speech recognition", async () => {
    const spoken = "Sunny, Garden Gate!";
    const t = await armPassphrase();
    expect((await consume(t, spoken, { candidateHashes: windowsOf(spoken) })).ok).toBe(true);
  });

  it("rejects a wrong phrase and never echoes the real one back", async () => {
    // Leaking the phrase in an error would defeat it entirely.
    const t = await armPassphrase();
    const r = await consume(t, "wrong words here", { candidateHashes: windowsOf("wrong words here") });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sunny");
  });

  it("rejects the employer's random word when the wallet is in passphrase mode", async () => {
    const t = await armPassphrase();
    expect((await consume(t, "mango", { candidateHashes: windowsOf("mango") })).ok).toBe(false);
  });

  it("cannot be confirmed when no phrase was ever set", async () => {
    const t = await setup();
    await arm(t, { mode: "passphrase" as const });
    const r = await consume(t, "anything", { candidateHashes: windowsOf("anything") });
    expect(r.ok).toBe(false);
  });
});

describe("withdrawal ledger — what makes the balance honest", () => {
  it("starts at zero", async () => {
    const t = await setup();
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-worker" })).toBe(0);
  });

  it("sums successful withdrawals", async () => {
    const t = await setup();
    for (const amountKobo of [100_000, 250_000]) {
      await t.mutation(api.wallets.recordWithdrawal, {
        accountId: "u-worker", amountKobo, accountName: "ADA OKAFOR", status: "SUCCESS", at: Date.now(),
      });
    }
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-worker" })).toBe(350_000);
  });

  it("excludes FAILED transfers, so money that never left is not deducted", async () => {
    const t = await setup();
    await t.mutation(api.wallets.recordWithdrawal, {
      accountId: "u-worker", amountKobo: 100_000, accountName: "A", status: "SUCCESS", at: Date.now(),
    });
    await t.mutation(api.wallets.recordWithdrawal, {
      accountId: "u-worker", amountKobo: 999_900, accountName: "A", status: "FAILED", at: Date.now(),
    });
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-worker" })).toBe(100_000);
  });

  it("counts a pending transfer, because the money is already committed", async () => {
    const t = await setup();
    await t.mutation(api.wallets.recordWithdrawal, {
      accountId: "u-worker", amountKobo: 200_000, accountName: "A", status: "PENDING_AUTHORIZATION", at: Date.now(),
    });
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-worker" })).toBe(200_000);
  });

  it("keeps one account's ledger out of another's", async () => {
    const t = await setup();
    await t.mutation(api.wallets.ensure, { accountId: "u-other", accountReference: "aide-u-other" });
    await t.mutation(api.wallets.recordWithdrawal, {
      accountId: "u-worker", amountKobo: 500_000, accountName: "A", status: "SUCCESS", at: Date.now(),
    });
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-other" })).toBe(0);
  });
});

describe("payout destination and the new-beneficiary hold", () => {
  it("timestamps a newly set destination so the cooling-off hold can start", async () => {
    const t = await setup();
    await t.mutation(api.wallets.setPayout, {
      accountId: "u-worker", accountReference: "aide-u-worker",
      payoutAccount: "0123456789", payoutBankCode: "058", payoutAccountName: "ADA OKAFOR",
    });
    const w = await t.query(api.wallets.getByAccount, { accountId: "u-worker" });
    expect(w?.payoutSetAt).toBeTypeOf("number");
  });

  it("does NOT restart the hold when the same destination is saved again", async () => {
    // Otherwise re-saving an old, trusted account would re-freeze it.
    const t = await setup();
    const args = {
      accountId: "u-worker", accountReference: "aide-u-worker",
      payoutAccount: "0123456789", payoutBankCode: "058", payoutAccountName: "ADA OKAFOR",
    };
    await t.mutation(api.wallets.setPayout, args);
    const first = (await t.query(api.wallets.getByAccount, { accountId: "u-worker" }))?.payoutSetAt;
    await t.mutation(api.wallets.setPayout, args);
    expect((await t.query(api.wallets.getByAccount, { accountId: "u-worker" }))?.payoutSetAt).toBe(first);
  });

  it("DOES restart the hold when the money is pointed somewhere new", async () => {
    // This is the protection: redirecting funds costs time, not a moment of
    // opportunity while someone else is in the room.
    const t = await setup();
    await t.mutation(api.wallets.setPayout, {
      accountId: "u-worker", accountReference: "aide-u-worker",
      payoutAccount: "0123456789", payoutBankCode: "058", payoutAccountName: "ADA OKAFOR",
    });
    const first = (await t.query(api.wallets.getByAccount, { accountId: "u-worker" }))?.payoutSetAt ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(api.wallets.setPayout, {
      accountId: "u-worker", accountReference: "aide-u-worker",
      payoutAccount: "9999999999", payoutBankCode: "011", payoutAccountName: "SOMEONE ELSE",
    });
    const second = (await t.query(api.wallets.getByAccount, { accountId: "u-worker" }))?.payoutSetAt ?? 0;
    expect(second).toBeGreaterThan(first);
  });
});

describe("beneficiaries", () => {
  const bene = {
    accountId: "u-worker", accountName: "ADA OKAFOR", accountNumber: "0123456789",
    bankCode: "058", at: Date.now(),
  };

  it("saves a new destination", async () => {
    const t = await setup();
    expect((await t.mutation(api.wallets.saveBeneficiary, bene)).created).toBe(true);
  });

  it("does not duplicate the same account", async () => {
    const t = await setup();
    await t.mutation(api.wallets.saveBeneficiary, bene);
    expect((await t.mutation(api.wallets.saveBeneficiary, bene)).created).toBe(false);
    expect(await t.query(api.wallets.listBeneficiaries, { accountId: "u-worker" })).toHaveLength(1);
  });

  it("treats the same number at a different bank as a different destination", async () => {
    const t = await setup();
    await t.mutation(api.wallets.saveBeneficiary, bene);
    expect((await t.mutation(api.wallets.saveBeneficiary, { ...bene, bankCode: "011" })).created).toBe(true);
  });

  it("never shows one account's beneficiaries to another", async () => {
    const t = await setup();
    await t.mutation(api.wallets.saveBeneficiary, bene);
    expect(await t.query(api.wallets.listBeneficiaries, { accountId: "u-other" })).toHaveLength(0);
  });
});

describe("wallet provisioning", () => {
  it("is idempotent, so concurrent requests cannot mint two wallets", async () => {
    const t = convexTest(schema, modules);
    await Promise.all([
      t.mutation(api.wallets.ensure, { accountId: "u-x", accountReference: "aide-u-x" }),
      t.mutation(api.wallets.ensure, { accountId: "u-x", accountReference: "aide-u-x" }),
      t.mutation(api.wallets.ensure, { accountId: "u-x", accountReference: "aide-u-x" }),
    ]);
    expect(await t.query(api.wallets.listActive, {})).toHaveLength(0);
    expect(await t.query(api.wallets.getByAccount, { accountId: "u-x" })).not.toBeNull();
  });

  it("marks a wallet active only once the bank account exists", async () => {
    const t = await setup();
    expect(await t.query(api.wallets.listActive, {})).toHaveLength(0);
    await t.mutation(api.wallets.setProvisioned, {
      accountId: "u-worker", accountReference: "aide-u-worker",
      accountNumber: "1234567890", bankName: "Wema Bank",
    });
    expect(await t.query(api.wallets.listActive, {})).toHaveLength(1);
  });

  it("records a provisioning failure so it can be retried", async () => {
    const t = await setup();
    await t.mutation(api.wallets.setFailed, {
      accountId: "u-worker", accountReference: "aide-u-worker", lastError: "bank rejected BVN",
    });
    const w = await t.query(api.wallets.getByAccount, { accountId: "u-worker" });
    expect(w?.status).toBe("failed");
    expect(w?.lastError).toBe("bank rejected BVN");
  });
});
