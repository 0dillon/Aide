import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";

// The armed withdrawal is the figure that becomes a transfer. Between arming
// and confirming there is a spoken exchange, so a pending can outlive a deploy:
// one armed in the naira era can be confirmed by the kobo era, minutes later.
// Reading that as kobo would send a hundredth of what the worker agreed to,
// and they would hear the right number spoken back at both ends.
const modules = import.meta.glob("../../convex/**/*.ts");

const setup = async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.wallets.ensure, { accountId: "u-worker", accountReference: "aide-u-worker" });
  return t;
};

const consume = (t: Awaited<ReturnType<typeof setup>>, spoken: string) =>
  t.mutation(api.wallets.consumePending, {
    accountId: "u-worker",
    spokenPhrase: spoken,
    now: Date.now(),
    ttlMs: 5 * 60 * 1000,
  });

describe("armed withdrawals in kobo", () => {
  it("returns the armed amount in whole kobo", async () => {
    const t = await setup();
    await t.mutation(api.wallets.armPending, {
      accountId: "u-worker",
      amountKobo: 500_000,
      phrase: "mango",
      mode: "word",
      destAccount: "0123456789",
      destBankCode: "058",
      destAccountName: "ADA OKAFOR",
      createdAt: Date.now(),
    });
    const r = await consume(t, "mango");
    expect(r.ok).toBe(true);
    expect(r.ok && r.amountKobo).toBe(500_000);
  });

  it("confirms a withdrawal armed in naira before the migration", async () => {
    const t = await setup();
    // A pending exactly as the pre-migration code wrote it: naira, no kobo.
    await t.run(async (ctx) => {
      const w = await ctx.db.query("wallets").withIndex("by_account", (q) => q.eq("accountId", "u-worker")).first();
      await ctx.db.patch(w!._id, {
        pendingWithdrawal: {
          amount: 5000,
          phrase: "mango",
          mode: "word" as const,
          destAccount: "0123456789",
          destBankCode: "058",
          destAccountName: "ADA OKAFOR",
          createdAt: Date.now(),
        },
      });
    });
    // ₦5,000 is 500,000 kobo. Reading the stored 5000 as kobo would transfer
    // ₦50 against a confirmation the worker gave for ₦5,000.
    const r = await consume(t, "mango");
    expect(r.ok).toBe(true);
    expect(r.ok && r.amountKobo).toBe(500_000);
  });
});
