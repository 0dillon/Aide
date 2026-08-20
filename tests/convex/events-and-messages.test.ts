import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";

// The event feed is how Aide learns money arrived and says so out loud, and how
// onboarding messages reach the other party. Both the webhook and the poller
// can report the same payment, from different serverless instances — so the
// dedupe here is what stops a user being told twice that they were paid.
const modules = import.meta.glob("../../convex/**/*.ts");

const payment = (over: Record<string, unknown> = {}) => ({
  accountId: "u-worker" as const,
  type: "payment" as const,
  amount: 12000,
  from: "ClearVoice Media",
  reference: "TX-ABC-1",
  ...over,
});

describe("payment events — announced once, and only once", () => {
  it("delivers a confirmed payment to the account that was paid", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.events.publish, payment());
    const events = await t.query(api.events.forAccount, { accountId: "u-worker", since: 0 });
    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(12000);
  });

  it("does not announce the same transaction twice", async () => {
    // The webhook and the poller both see it. The user must hear it once.
    const t = convexTest(schema, modules);
    await t.mutation(api.events.publish, payment());
    await t.mutation(api.events.publish, payment());
    expect(await t.query(api.events.forAccount, { accountId: "u-worker", since: 0 })).toHaveLength(1);
  });

  it("still announces a genuinely different transaction", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.events.publish, payment());
    await t.mutation(api.events.publish, payment({ reference: "TX-ABC-2" }));
    expect(await t.query(api.events.forAccount, { accountId: "u-worker", since: 0 })).toHaveLength(2);
  });

  it("dedupes per account, so two people paid under one reference both hear it", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.events.publish, payment());
    await t.mutation(api.events.publish, payment({ accountId: "u-other" }));
    expect(await t.query(api.events.forAccount, { accountId: "u-other", since: 0 })).toHaveLength(1);
  });

  it("never leaks one account's money into another's feed", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.events.publish, payment());
    expect(await t.query(api.events.forAccount, { accountId: "u-someone-else", since: 0 })).toHaveLength(0);
  });

  it("survives concurrent delivery of the same payment", async () => {
    const t = convexTest(schema, modules);
    await Promise.all([
      t.mutation(api.events.publish, payment()),
      t.mutation(api.events.publish, payment()),
      t.mutation(api.events.publish, payment()),
    ]);
    const events = await t.query(api.events.forAccount, { accountId: "u-worker", since: 0 });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(new Set(events.map((e) => e.reference)).size).toBe(1);
  });
});

describe("event replay window", () => {
  it("excludes history older than the browser's mount time", async () => {
    // Otherwise every reload re-announces old payments as if money just landed.
    const t = convexTest(schema, modules);
    await t.mutation(api.events.publish, payment({ reference: "OLD", at: 1_000 }));
    await t.mutation(api.events.publish, payment({ reference: "NEW", at: 9_000 }));
    const recent = await t.query(api.events.forAccount, { accountId: "u-worker", since: 5_000 });
    expect(recent.map((e) => e.reference)).toEqual(["NEW"]);
  });

  it("returns events oldest first, so they are spoken in order", async () => {
    const t = convexTest(schema, modules);
    for (const [reference, at] of [["A", 1_000], ["B", 2_000], ["C", 3_000]] as const) {
      await t.mutation(api.events.publish, payment({ reference, at }));
    }
    const events = await t.query(api.events.forAccount, { accountId: "u-worker", since: 0 });
    expect(events.map((e) => e.reference)).toEqual(["A", "B", "C"]);
  });

  it("carries a spoken notification with its message", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.events.publish, {
      accountId: "u-worker", type: "notify", message: "You have been hired for Audio transcription.",
    });
    const [event] = await t.query(api.events.forAccount, { accountId: "u-worker", since: 0 });
    expect(event.type).toBe("notify");
    expect(event.message).toContain("hired");
  });

  it("does not dedupe notifications, which legitimately repeat", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 2; i++) {
      await t.mutation(api.events.publish, { accountId: "u-worker", type: "notify", message: "New message" });
    }
    expect(await t.query(api.events.forAccount, { accountId: "u-worker", since: 0 })).toHaveLength(2);
  });
});

describe("onboarding message thread", () => {
  const send = (t: any, over: Record<string, unknown> = {}) =>
    t.mutation(api.messages.send, {
      jobId: "j1", workerAccountId: "demo-worker", from: "employer" as const,
      authorName: "ClearVoice Media", text: "Your login is on the portal.", ...over,
    });

  it("stores a message with its author and side", async () => {
    const t = convexTest(schema, modules);
    await send(t);
    const [m] = await t.query(api.messages.listForJob, { jobId: "j1" });
    expect(m.from).toBe("employer");
    expect(m.authorName).toBe("ClearVoice Media");
    expect(m.text).toBe("Your login is on the portal.");
  });

  it("reads oldest first, so the conversation makes sense aloud", async () => {
    const t = convexTest(schema, modules);
    await send(t, { text: "first" });
    await send(t, { text: "second", from: "worker", authorName: "Aide Demo Worker" });
    await send(t, { text: "third" });
    expect((await t.query(api.messages.listForJob, { jobId: "j1" })).map((m: any) => m.text)).toEqual([
      "first", "second", "third",
    ]);
  });

  it("keeps each gig's conversation to itself", async () => {
    const t = convexTest(schema, modules);
    await send(t, { jobId: "j1", text: "for j1" });
    await send(t, { jobId: "j2", text: "for j2" });
    expect((await t.query(api.messages.listForJob, { jobId: "j1" })).map((m: any) => m.text)).toEqual(["for j1"]);
  });

  it("preserves credentials verbatim, including spacing and case", async () => {
    // Employers pass real credentials through here and Aide reads them aloud.
    // Any normalization would hand the worker something that does not work.
    const t = convexTest(schema, modules);
    const secret = "  User: Ada_O   Pass: Tr0ub4dor&3  ";
    await send(t, { text: secret });
    expect((await t.query(api.messages.listForJob, { jobId: "j1" }))[0].text).toBe(secret);
  });

  it("returns an empty thread rather than failing when nothing has been said", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.messages.listForJob, { jobId: "untouched" })).toEqual([]);
  });
});
