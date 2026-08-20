import { describe, expect, it } from "vitest";
import { assessmentPromptFor, publicJob, validateGig } from "../../lib/store/jobs";
import { accountIdFromWalletReference, walletReferenceFor } from "../../lib/store/payments";
import type { Job } from "../../lib/store/state";

// validateGig is the single gate both the on-screen form and Aide's voice tool
// pass through, so a gig accepted by voice is accepted on screen and vice
// versa. If they drift, the two paths silently disagree about what is legal.

describe("validateGig", () => {
  const base = { title: "Transcribe a podcast", skill: "transcription", pay: 12000, requiresAssessment: false };

  it("accepts a well-formed gig", () => {
    const r = validateGig(base);
    expect(r.ok).toBe(true);
  });

  it("requires a title and a skill", () => {
    expect(validateGig({ ...base, title: "  " }).ok).toBe(false);
    expect(validateGig({ ...base, skill: "" }).ok).toBe(false);
  });

  it("refuses pay that is not a positive amount", () => {
    // A gig paying zero or negative is a data-entry error, and by voice it is
    // a misheard number. Either way it must not be postable.
    for (const pay of [0, -1, NaN, Infinity]) {
      expect(validateGig({ ...base, pay }).ok, `pay=${pay}`).toBe(false);
    }
  });

  it("requires questions when the assessment is multiple choice", () => {
    const r = validateGig({ ...base, requiresAssessment: true, assessmentType: "mcq", mcqQuestions: [] });
    expect(r.ok).toBe(false);
  });

  it("refuses a correct answer that is out of range", () => {
    // correctIndex past the options means no answer can ever be right.
    const r = validateGig({
      ...base,
      requiresAssessment: true,
      assessmentType: "mcq",
      mcqQuestions: [{ question: "Q1", options: ["a", "b"], correctIndex: 5 }],
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a question with fewer than two options", () => {
    const r = validateGig({
      ...base,
      requiresAssessment: true,
      assessmentType: "mcq",
      mcqQuestions: [{ question: "Q1", options: ["only one"], correctIndex: 0 }],
    });
    expect(r.ok).toBe(false);
  });

  it("bounds the time limit", () => {
    expect(validateGig({ ...base, timeLimit: 0 }).ok).toBe(false);
    expect(validateGig({ ...base, timeLimit: 3601 }).ok).toBe(false);
    expect(validateGig({ ...base, timeLimit: 600 }).ok).toBe(true);
  });

  it("drops assessment details when no assessment is required", () => {
    const r = validateGig({ ...base, requiresAssessment: false, assessmentType: "mcq" });
    expect(r.ok && r.gig.assessmentType).toBeUndefined();
  });
});

// Assessment integrity. publicJob is the only thing keeping correct answers on
// the server. It feeds both the jobs API and the snapshot sent to the browser
// with every agent reply, so a regression here hands every answer to anyone
// who opens devtools — and to the model, which is told never to reveal them.
describe("publicJob — answers must never leave the server", () => {
  const job: Job = {
    id: "g-1",
    title: "Bank codes quiz",
    task: "Answer two questions",
    skill: "banking",
    pay: 5000,
    employer: "ClearVoice Media",
    requiresAssessment: true,
    assessmentType: "mcq",
    mcqQuestions: [
      { question: "Wema Bank NIP code?", options: ["035", "058", "011"], correctIndex: 0 },
      { question: "GTBank NIP code?", options: ["035", "058"], correctIndex: 1 },
    ],
  };

  it("strips correctIndex from every question", () => {
    const pub = publicJob(job);
    for (const q of pub.mcqQuestions ?? []) {
      expect(q).not.toHaveProperty("correctIndex");
    }
  });

  it("leaves no trace of the answer anywhere in the serialized payload", () => {
    // Belt and braces: whatever the shape, the string "correctIndex" must not
    // survive serialization to the client.
    expect(JSON.stringify(publicJob(job))).not.toContain("correctIndex");
  });

  it("still gives the worker the question and its options", () => {
    const pub = publicJob(job);
    expect(pub.mcqQuestions?.[0].question).toBe("Wema Bank NIP code?");
    expect(pub.mcqQuestions?.[0].options).toEqual(["035", "058", "011"]);
  });

  it("does not mutate the original job", () => {
    publicJob(job);
    expect(job.mcqQuestions?.[0].correctIndex).toBe(0);
  });

  it("passes through a job with no assessment untouched", () => {
    const plain: Job = { ...job, requiresAssessment: false, assessmentType: undefined, mcqQuestions: undefined };
    expect(publicJob(plain).mcqQuestions).toBeUndefined();
  });
});

describe("assessmentPromptFor", () => {
  const job: Job = {
    id: "g-2", title: "T", task: "Transcribe an interview", skill: "transcription",
    pay: 1000, employer: "E", requiresAssessment: true,
  };

  it("prefers the employer's own wording", () => {
    expect(assessmentPromptFor({ ...job, assessmentQuestion: "How do you handle accents?" })).toBe(
      "How do you handle accents?",
    );
  });

  it("falls back to a prompt derived from the task", () => {
    const prompt = assessmentPromptFor(job);
    expect(prompt).toContain("transcription");
    expect(prompt).toContain("Transcribe an interview");
  });
});

// Wallet references map an Aide account to its real bank NUBAN. A mistake here
// points one person's earnings at another person's account.
describe("wallet reference mapping", () => {
  it("round-trips a normal account", () => {
    expect(accountIdFromWalletReference(walletReferenceFor("u-abc123"))).toBe("u-abc123");
  });

  it("keeps the demo worker's legacy reference so its funded account survives", () => {
    expect(walletReferenceFor("demo-worker")).toBe("aide-demo-worker");
    expect(accountIdFromWalletReference("aide-demo-worker")).toBe("demo-worker");
  });

  it("gives different accounts different references", () => {
    expect(walletReferenceFor("u-aaa")).not.toBe(walletReferenceFor("u-bbb"));
  });

  it("refuses a reference that is not ours", () => {
    expect(accountIdFromWalletReference("someone-else-ref")).toBeUndefined();
    expect(accountIdFromWalletReference("")).toBeUndefined();
  });
});
