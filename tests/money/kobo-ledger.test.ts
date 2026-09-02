import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";

// The ledger is the one place a unit mix-up is unrecoverable: a row written in
// naira and later read as kobo is off by a hundred, and the worker it belongs
// to cannot see the number to dispute it. Rows written before this migration
// carry naira in `amount`; rows written after carry kobo in `amountKobo`. Both
// must total correctly, forever, without a migration step anyone has to
// remember to run.
const modules = import.meta.glob("../../convex/**/*.ts");

const setup = async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.wallets.ensure, { accountId: "u-worker", accountReference: "aide-u-worker" });
  return t;
};

describe("withdrawnTotal in kobo", () => {
  it("totals withdrawals recorded in kobo", async () => {
    const t = await setup();
    await t.mutation(api.wallets.recordWithdrawal, {
      accountId: "u-worker",
      amountKobo: 350_000,
      accountName: "ADA OKAFOR",
      status: "SUCCESS",
      at: Date.now(),
    });
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-worker" })).toBe(350_000);
  });

  it("reads a legacy naira row as kobo instead of under-counting it a hundredfold", async () => {
    const t = await setup();
    // A row exactly as the pre-migration code wrote it: naira, no kobo field.
    await t.run(async (ctx) => {
      await ctx.db.insert("withdrawals", {
        accountId: "u-worker",
        amount: 3500,
        accountName: "ADA OKAFOR",
        status: "SUCCESS",
        at: Date.now(),
      });
    });
    // ₦3,500 is 350,000 kobo. Reading the stored 3500 as kobo would call it
    // ₦35 and invite the worker to withdraw money that is not there.
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-worker" })).toBe(350_000);
  });

  it("totals a mix of legacy naira and new kobo rows", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("withdrawals", {
        accountId: "u-worker",
        amount: 1000,
        accountName: "ADA OKAFOR",
        status: "SUCCESS",
        at: Date.now(),
      });
    });
    await t.mutation(api.wallets.recordWithdrawal, {
      accountId: "u-worker",
      amountKobo: 250_000,
      accountName: "ADA OKAFOR",
      status: "SUCCESS",
      at: Date.now(),
    });
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-worker" })).toBe(350_000);
  });

  it("still excludes FAILED withdrawals from the total", async () => {
    const t = await setup();
    await t.mutation(api.wallets.recordWithdrawal, {
      accountId: "u-worker",
      amountKobo: 100_000,
      accountName: "ADA OKAFOR",
      status: "FAILED",
      at: Date.now(),
    });
    expect(await t.query(api.wallets.withdrawnTotal, { accountId: "u-worker" })).toBe(0);
  });
});
