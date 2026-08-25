import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";

// Taking something back is a write like any other, so it needs the same
// question answered: whose is it? These guards live in the Convex mutations
// rather than in the route, so two requests cannot race each other and no
// second entry point (the voice tool, a curl) can skip them.
const modules = import.meta.glob("../../convex/**/*.ts");

const ME = "u-worker-1";
const SOMEONE_ELSE = "u-worker-2";
const EMPLOYER = "u-emp-1";
const RIVAL = "u-emp-2";

const gig = (accountId?: string) => ({
  jobId: "g-1",
  title: "Transcribe an interview",
  task: "t",
  skill: "transcription",
  pay: 12000,
  employer: "ClearVoice Media",
  employerAccountId: accountId,
  requiresAssessment: true,
});

describe("withdrawing an application", () => {
  it("removes your own application while it is still just an application", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.applications.apply, { accountId: ME, jobId: "g-1" });
    expect(await t.mutation(api.applications.remove, { accountId: ME, jobId: "g-1" })).toEqual({ ok: true });
    expect(await t.query(api.applications.getForJob, { accountId: ME, jobId: "g-1" })).toBeNull();
  });

  it("refuses once the assessment clock has started", async () => {
    // An attempt row means the questions have been handed out. Allowing a
    // withdrawal here would be a way to quietly retake a one-shot test.
    const t = convexTest(schema, modules);
    await t.mutation(api.applications.apply, { accountId: ME, jobId: "g-1" });
    await t.mutation(api.jobs.recordAttempt, { key: `${ME}-g-1`, startedAt: Date.now() });
    const r = await t.mutation(api.applications.remove, { accountId: ME, jobId: "g-1" });
    expect(r).toEqual({ ok: false, reason: "started" });
    expect(await t.query(api.applications.getForJob, { accountId: ME, jobId: "g-1" })).not.toBeNull();
  });

  it("refuses once the assessment has been graded", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.applications.apply, { accountId: ME, jobId: "g-1" });
    await t.mutation(api.applications.setStatus, {
      accountId: ME,
      jobId: "g-1",
      verified: true,
      status: "assessed",
    });
    expect(await t.mutation(api.applications.remove, { accountId: ME, jobId: "g-1" })).toEqual({
      ok: false,
      reason: "started",
    });
  });

  it("refuses to withdraw a cancelled application, so the lockout survives", async () => {
    // Cancelling bars you from the job forever. Deleting the record afterwards
    // would let you apply again as though it never happened.
    const t = convexTest(schema, modules);
    await t.mutation(api.applications.apply, { accountId: ME, jobId: "g-1" });
    await t.mutation(api.applications.setStatus, { accountId: ME, jobId: "g-1", status: "cancelled" });
    expect(await t.mutation(api.applications.remove, { accountId: ME, jobId: "g-1" })).toEqual({
      ok: false,
      reason: "started",
    });
  });

  it("never touches somebody else's application to the same gig", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.applications.apply, { accountId: ME, jobId: "g-1" });
    await t.mutation(api.applications.apply, { accountId: SOMEONE_ELSE, jobId: "g-1" });
    await t.mutation(api.applications.remove, { accountId: ME, jobId: "g-1" });
    expect(await t.query(api.applications.getForJob, { accountId: SOMEONE_ELSE, jobId: "g-1" })).not.toBeNull();
  });
});

describe("removing a gig you posted", () => {
  it("removes it, and the pending applications with it", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.post, gig(EMPLOYER));
    await t.mutation(api.applications.apply, { accountId: ME, jobId: "g-1" });
    const r = await t.mutation(api.jobs.removePosted, { jobId: "g-1", accountId: EMPLOYER });
    expect(r).toEqual({ ok: true, removedApplications: 1 });
    expect(await t.query(api.jobs.listPosted, {})).toHaveLength(0);
    // An application pointing at a gig that no longer exists would show a
    // worker a job they can never hear about again.
    expect(await t.query(api.applications.getForJob, { accountId: ME, jobId: "g-1" })).toBeNull();
  });

  it("refuses a rival employer", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.post, gig(EMPLOYER));
    expect(await t.mutation(api.jobs.removePosted, { jobId: "g-1", accountId: RIVAL })).toEqual({
      ok: false,
      reason: "not-yours",
    });
    expect(await t.query(api.jobs.listPosted, {})).toHaveLength(1);
  });

  it("refuses a gig with no recorded owner, rather than guessing", async () => {
    // Gigs posted before employerAccountId existed. Refusing is the safe
    // direction: nobody can delete them, instead of anybody being able to.
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.post, gig(undefined));
    expect(await t.mutation(api.jobs.removePosted, { jobId: "g-1", accountId: EMPLOYER })).toEqual({
      ok: false,
      reason: "not-yours",
    });
  });

  it("refuses once somebody has been hired", async () => {
    // At that point the gig is the record of work that was agreed. Removing it
    // would strand the worker's application and their onboarding thread.
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.post, gig(EMPLOYER));
    await t.mutation(api.applications.apply, { accountId: ME, jobId: "g-1" });
    await t.mutation(api.applications.setStatus, { accountId: ME, jobId: "g-1", status: "hired" });
    expect(await t.mutation(api.jobs.removePosted, { jobId: "g-1", accountId: EMPLOYER })).toEqual({
      ok: false,
      reason: "committed",
    });
    expect(await t.query(api.jobs.listPosted, {})).toHaveLength(1);
  });

  it("refuses once somebody has been paid", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.post, gig(EMPLOYER));
    await t.mutation(api.applications.apply, { accountId: ME, jobId: "g-1" });
    await t.mutation(api.applications.setStatus, { accountId: ME, jobId: "g-1", status: "paid" });
    expect(await t.mutation(api.jobs.removePosted, { jobId: "g-1", accountId: EMPLOYER })).toEqual({
      ok: false,
      reason: "committed",
    });
  });
});

describe("deleting a message", () => {
  const send = async (t: any, authorAccountId?: string) =>
    await t.mutation(api.messages.send, {
      jobId: "g-1",
      workerAccountId: ME,
      from: "employer" as const,
      authorAccountId,
      authorName: "ClearVoice Media",
      text: "The login is admin / hunter2",
    });

  it("deletes your own message", async () => {
    const t = convexTest(schema, modules);
    const m = await send(t, EMPLOYER);
    expect(await t.mutation(api.messages.remove, { messageId: m._id, accountId: EMPLOYER })).toMatchObject({ ok: true });
    expect(await t.query(api.messages.listForJob, { jobId: "g-1" })).toHaveLength(0);
  });

  it("refuses somebody else's message, even the other party to the thread", async () => {
    const t = convexTest(schema, modules);
    const m = await send(t, EMPLOYER);
    expect(await t.mutation(api.messages.remove, { messageId: m._id, accountId: ME })).toEqual({
      ok: false,
      reason: "not-yours",
    });
    expect(await t.query(api.messages.listForJob, { jobId: "g-1" })).toHaveLength(1);
  });

  it("refuses a message with no recorded author, rather than guessing from a name", async () => {
    const t = convexTest(schema, modules);
    const m = await send(t, undefined);
    expect(await t.mutation(api.messages.remove, { messageId: m._id, accountId: EMPLOYER })).toEqual({
      ok: false,
      reason: "not-yours",
    });
  });
});
