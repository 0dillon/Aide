import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatch, type ConvexCall, type Handlers } from "../helpers/fake-convex";

// Grading decides whether someone gets the job. It has to be exact about the
// pass mark, honest about the clock, and — above all — it must never let the
// correct answers escape to the worker or to the model.

const hoisted = vi.hoisted(() => ({
  dispatch: (_ref: any, _args: any): any => {
    throw new Error("dispatch not installed");
  },
}));

vi.mock("../../lib/convex-server", () => ({
  convexClient: () => ({
    query: (ref: any, args: any) => hoisted.dispatch(ref, args),
    mutation: (ref: any, args: any) => hoisted.dispatch(ref, args),
  }),
  publishConvexEvent: () => Promise.resolve(),
}));

const { beginAssessment, gradeMcqAssessment, gradeOralAssessment, startAssessment, timeRemaining } = await import(
  "../../lib/store/applications"
);

const QUIZ = {
  jobId: "g-quiz",
  title: "Bank codes",
  task: "Answer the questions",
  skill: "banking",
  pay: 5000,
  employer: "ClearVoice Media",
  requiresAssessment: true,
  assessmentType: "mcq" as const,
  mcqQuestions: [
    { question: "Wema?", options: ["035", "058", "011"], correctIndex: 0 },
    { question: "GTBank?", options: ["035", "058"], correctIndex: 1 },
    { question: "UBA?", options: ["033", "011"], correctIndex: 0 },
    { question: "Zenith?", options: ["057", "070"], correctIndex: 0 },
  ],
  at: Date.now(),
};

let calls: ConvexCall[];
let handlers: Handlers;

beforeEach(() => {
  calls = [];
  handlers = {
    "jobs:listPosted": () => [QUIZ],
    "jobs:getAttempt": () => Date.now() - 5000,
    "jobs:recordAttempt": () => null,
    // Returns the start it kept, which is how "first call wins" is enforced.
    "jobs:beginAttempt": (a: any) => a.startedAt,
    "jobs:clearAttempt": () => null,
    "applications:setStatus": () => ({ _id: "a1", accountId: "demo-worker", jobId: "g-quiz", status: "assessed", verified: true }),
    "applications:getForJob": () => ({ _id: "a1", accountId: "demo-worker", jobId: "g-quiz", status: "applied", verified: false }),
    "applications:listForAccount": () => [],
  };
  hoisted.dispatch = makeDispatch(handlers, calls);
});

const verifiedWrites = () =>
  calls.filter((c) => c.name === "applications:setStatus" && c.args.verified === true);

describe("multiple choice scoring", () => {
  it("passes a perfect score", async () => {
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [0, 1, 0, 0]);
    expect(r.verified).toBe(true);
    expect(r.score).toBe(4);
    expect(r.total).toBe(4);
  });

  it("passes at exactly the 70 percent threshold", async () => {
    // 3 of 4 is 75%. The boundary is where an off-by-one costs someone a job.
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [0, 1, 0, 1]);
    expect(r.score).toBe(3);
    expect(r.verified).toBe(true);
  });

  it("fails just below the threshold", async () => {
    // 2 of 4 is 50%.
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [0, 1, 1, 1]);
    expect(r.score).toBe(2);
    expect(r.verified).toBe(false);
  });

  it("fails an empty submission rather than passing it by default", async () => {
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", []);
    expect(r.verified).toBe(false);
    expect(r.score).toBe(0);
  });

  it("does not credit an unanswered question", async () => {
    // -1 is the panel's "nothing selected" marker.
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [-1, -1, -1, -1]);
    expect(r.score).toBe(0);
  });

  it("marks the application verified only when the worker passed", async () => {
    await gradeMcqAssessment("demo-worker", "g-quiz", [0, 1, 0, 0]);
    expect(verifiedWrites()).toHaveLength(1);
  });

  it("does not mark a failed attempt as verified", async () => {
    await gradeMcqAssessment("demo-worker", "g-quiz", [1, 0, 1, 1]);
    expect(verifiedWrites()).toHaveLength(0);
  });

  it("records a readable result for the employer", async () => {
    await gradeMcqAssessment("demo-worker", "g-quiz", [0, 1, 0, 0]);
    const write = calls.find((c) => c.name === "applications:setStatus" && c.args.assessmentResult);
    expect(write?.args.assessmentResult).toMatch(/MCQ: 4 of 4 \(100%\)/);
  });

  it("never puts the correct answers in what it returns", async () => {
    // The result is handed to the model, which is told not to reveal answers.
    // The safest guarantee is that it never receives them in the first place.
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [1, 0, 1, 1]);
    expect(JSON.stringify(r)).not.toContain("correctIndex");
    expect(r.message).not.toMatch(/035|058|033|057/);
  });

  it("refuses to grade a job that has no questions", async () => {
    handlers["jobs:listPosted"] = () => [{ ...QUIZ, mcqQuestions: [] }];
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [0]);
    expect(r.verified).toBe(false);
    expect(r.message).toMatch(/does not have MCQ/i);
  });

  it("reports a missing job instead of throwing", async () => {
    handlers["jobs:listPosted"] = () => [];
    const r = await gradeMcqAssessment("demo-worker", "nope", [0]);
    expect(r.verified).toBe(false);
  });
});

describe("time limits", () => {
  const TIMED = { ...QUIZ, timeLimit: 60 };

  it("fails a submission that arrived after time ran out", async () => {
    handlers["jobs:listPosted"] = () => [TIMED];
    handlers["jobs:getAttempt"] = () => Date.now() - 120_000; // 2 minutes on a 1 minute limit
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [0, 1, 0, 0]);
    expect(r.verified).toBe(false);
    expect(r.message).toMatch(/time limit exceeded/i);
    expect(verifiedWrites()).toHaveLength(0);
  });

  it("allows a small grace period, so a slow network does not fail an honest answer", async () => {
    handlers["jobs:listPosted"] = () => [TIMED];
    handlers["jobs:getAttempt"] = () => Date.now() - 65_000; // 5s over a 60s limit
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [0, 1, 0, 0]);
    expect(r.verified).toBe(true);
  });

  it("does not expire an assessment that has no limit", async () => {
    handlers["jobs:getAttempt"] = () => Date.now() - 10 * 60 * 1000;
    const r = await gradeMcqAssessment("demo-worker", "g-quiz", [0, 1, 0, 0]);
    expect(r.verified).toBe(true);
  });

  it("reports remaining time honestly so Aide can say it aloud", async () => {
    handlers["jobs:listPosted"] = () => [TIMED];
    handlers["jobs:getAttempt"] = () => Date.now() - 20_000;
    const t = await timeRemaining("demo-worker", "g-quiz");
    expect(t?.limit).toBe(60);
    expect(t?.remaining).toBeGreaterThan(35);
    expect(t?.remaining).toBeLessThanOrEqual(40);
  });

  it("never reports negative time left", async () => {
    handlers["jobs:listPosted"] = () => [TIMED];
    handlers["jobs:getAttempt"] = () => Date.now() - 600_000;
    expect((await timeRemaining("demo-worker", "g-quiz"))?.remaining).toBe(0);
  });

  it("has nothing to report when the assessment was never started", async () => {
    handlers["jobs:listPosted"] = () => [TIMED];
    handlers["jobs:getAttempt"] = () => null;
    expect(await timeRemaining("demo-worker", "g-quiz")).toBeNull();
  });
});

describe("starting an assessment", () => {
  it("hands out questions with the answers stripped", async () => {
    const started = await startAssessment("demo-worker", "g-quiz");
    expect(started.ok).toBe(true);
    expect(JSON.stringify(started)).not.toContain("correctIndex");
  });

  it("still includes every question and option", async () => {
    const started = await startAssessment("demo-worker", "g-quiz");
    expect(started.ok && started.assessmentType === "mcq" && started.questions).toHaveLength(4);
  });

  it("refuses to restart an assessment the worker cancelled", async () => {
    // The lockout the user was warned about must hold on this path too.
    handlers["applications:getForJob"] = () => ({ _id: "a1", accountId: "demo-worker", jobId: "g-quiz", status: "cancelled", verified: false });
    const started = await startAssessment("demo-worker", "g-quiz");
    expect(started.ok).toBe(false);
    expect(!started.ok && started.message).toMatch(/cannot retake|no longer|cancelled/i);
  });

  it("hands out the questions without starting the clock", async () => {
    // Preparing an assessment is not beginning one. The clock used to start
    // the instant this returned, while Aide was still explaining the rules and
    // reading every question and option aloud — on a two-minute assessment
    // that can be most of the time, spent before the worker has heard the
    // first question, with no countdown they can see to notice.
    await startAssessment("demo-worker", "g-quiz");
    expect(calls.some((c) => c.name === "jobs:recordAttempt")).toBe(false);
    expect(calls.some((c) => c.name === "jobs:beginAttempt")).toBe(false);
  });

  it("starts the clock only when the worker is ready, and keeps it server-side", async () => {
    await beginAssessment("demo-worker", "g-quiz");
    expect(calls.some((c) => c.name === "jobs:beginAttempt")).toBe(true);
  });
});

describe("oral grading without a model configured", () => {
  // With no API key the rubric grader falls back to a length heuristic. It must
  // still be deterministic and must never crash an assessment.
  const noKey = () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    return () => { if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved; };
  };

  it("rejects a one-word answer", async () => {
    const restore = noKey();
    handlers["jobs:listPosted"] = () => [{ ...QUIZ, assessmentType: "oral", mcqQuestions: undefined }];
    const r = await gradeOralAssessment("demo-worker", "g-quiz", "yes");
    restore();
    expect(r.verified).toBe(false);
  });

  it("accepts a substantive spoken answer", async () => {
    const restore = noKey();
    handlers["jobs:listPosted"] = () => [{ ...QUIZ, assessmentType: "oral", mcqQuestions: undefined }];
    const r = await gradeOralAssessment(
      "demo-worker",
      "g-quiz",
      "I would listen through the whole recording first, then transcribe in short passages and check the speaker labels carefully.",
    );
    restore();
    expect(r.verified).toBe(true);
  });
});
