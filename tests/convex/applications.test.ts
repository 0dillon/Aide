import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";

// The application state machine decides whether someone is hired and whether a
// gig counts as paid. The cancel lockout is the harshest rule in the product —
// it permanently bars a worker from a job — so it must fire exactly when
// intended and never by accident.
const modules = import.meta.glob("../../convex/**/*.ts");

const applied = async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.applications.apply, { accountId: "demo-worker", jobId: "j1" });
  return t;
};
const statusOf = async (t: any, jobId = "j1") =>
  (await t.query(api.applications.getForJob, { accountId: "demo-worker", jobId }))?.status;

describe("applying", () => {
  it("starts unverified and applied", async () => {
    const t = await applied();
    const app = await t.query(api.applications.getForJob, { accountId: "demo-worker", jobId: "j1" });
    expect(app?.status).toBe("applied");
    expect(app?.verified).toBe(false);
  });

  it("is idempotent — applying twice does not create a second application", async () => {
    const t = await applied();
    await t.mutation(api.applications.apply, { accountId: "demo-worker", jobId: "j1" });
    expect(await t.query(api.applications.listForAccount, { accountId: "demo-worker" })).toHaveLength(1);
  });

  it("keeps each account's applications separate", async () => {
    const t = await applied();
    expect(await t.query(api.applications.listForAccount, { accountId: "u-someone-else" })).toHaveLength(0);
  });
});

describe("assessment cancellation — a one-way door", () => {
  const cancel = (t: any) =>
    t.mutation(api.applications.setStatus, {
      accountId: "demo-worker", jobId: "j1", status: "cancelled",
      assessmentResult: "Assessment cancelled by worker",
      requireStatus: "applied", requireUnverified: true,
    });

  it("cancels an assessment that is still in progress", async () => {
    const t = await applied();
    await cancel(t);
    expect(await statusOf(t)).toBe("cancelled");
  });

  it("STAYS cancelled when the worker re-applies", async () => {
    // The lockout is the whole point. If re-applying silently reopened the
    // job, the warning the user agreed to would have been a lie.
    const t = await applied();
    await cancel(t);
    await t.mutation(api.applications.apply, { accountId: "demo-worker", jobId: "j1" });
    expect(await statusOf(t)).toBe("cancelled");
  });

  it("cannot cancel a worker who already passed", async () => {
    // Guards the race where grading lands as the user says "cancel". Passing
    // must win: nobody should lose a verified skill to a timing accident.
    const t = await applied();
    await t.mutation(api.applications.setStatus, {
      accountId: "demo-worker", jobId: "j1", status: "assessed", verified: true,
    });
    await cancel(t);
    expect(await statusOf(t)).toBe("assessed");
  });

  it("cannot cancel someone who is already hired", async () => {
    const t = await applied();
    await t.mutation(api.applications.setStatus, { accountId: "demo-worker", jobId: "j1", status: "hired" });
    await cancel(t);
    expect(await statusOf(t)).toBe("hired");
  });

  it("only one of several simultaneous cancels takes effect, and the state is sane", async () => {
    const t = await applied();
    await Promise.all([cancel(t), cancel(t), cancel(t)]);
    expect(await statusOf(t)).toBe("cancelled");
  });
});

describe("hiring lifecycle", () => {
  it("moves through assessed, hired, and paid", async () => {
    const t = await applied();
    await t.mutation(api.applications.setStatus, {
      accountId: "demo-worker", jobId: "j1", status: "assessed", verified: true,
      assessmentResult: "MCQ: 2 of 2 (100%)",
    });
    expect(await statusOf(t)).toBe("assessed");

    await t.mutation(api.applications.setStatus, { accountId: "demo-worker", jobId: "j1", status: "hired" });
    expect(await statusOf(t)).toBe("hired");

    await t.mutation(api.applications.setStatus, { accountId: "demo-worker", jobId: "j1", status: "paid" });
    expect(await statusOf(t)).toBe("paid");
  });

  it("keeps the assessment result visible to the employer after hiring", async () => {
    const t = await applied();
    await t.mutation(api.applications.setStatus, {
      accountId: "demo-worker", jobId: "j1", verified: true, status: "assessed",
      assessmentResult: "MCQ: 2 of 2 (100%)",
    });
    await t.mutation(api.applications.setStatus, { accountId: "demo-worker", jobId: "j1", status: "hired" });
    const app = await t.query(api.applications.getForJob, { accountId: "demo-worker", jobId: "j1" });
    expect(app?.assessmentResult).toBe("MCQ: 2 of 2 (100%)");
    expect(app?.verified).toBe(true);
  });

  it("returns null for a job never applied to, rather than inventing one", async () => {
    const t = await applied();
    expect(await t.query(api.applications.getForJob, { accountId: "demo-worker", jobId: "never" })).toBeNull();
    expect(
      await t.mutation(api.applications.setStatus, { accountId: "demo-worker", jobId: "never", status: "hired" }),
    ).toBeNull();
  });
});

describe("assessment attempt timing", () => {
  it("records and clears a start time", async () => {
    const t = convexTest(schema, modules);
    const key = "demo-worker-j1";
    expect(await t.query(api.jobs.getAttempt, { key })).toBeNull();

    await t.mutation(api.jobs.recordAttempt, { key, startedAt: 1_000_000 });
    expect(await t.query(api.jobs.getAttempt, { key })).toBe(1_000_000);

    await t.mutation(api.jobs.clearAttempt, { key });
    expect(await t.query(api.jobs.getAttempt, { key })).toBeNull();
  });

  it("restarting an assessment resets the clock rather than stacking attempts", async () => {
    const t = convexTest(schema, modules);
    const key = "demo-worker-j1";
    await t.mutation(api.jobs.recordAttempt, { key, startedAt: 1_000 });
    await t.mutation(api.jobs.recordAttempt, { key, startedAt: 2_000 });
    expect(await t.query(api.jobs.getAttempt, { key })).toBe(2_000);
  });

  it("keeps each worker's clock on each job separate", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.jobs.recordAttempt, { key: "worker-a-j1", startedAt: 1_000 });
    expect(await t.query(api.jobs.getAttempt, { key: "worker-b-j1" })).toBeNull();
  });
});
