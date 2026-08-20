import { beforeEach, describe, expect, it, vi } from "vitest";

// Aide's tools are the only way the model can touch anything real. The model
// is instructed to behave, but instructions are not a security boundary — a
// user can say anything, and gig text and messages are attacker-controlled
// data the model reads. So every guard has to live in the tool itself.

const store = vi.hoisted(() => ({
  listJobs: vi.fn(), getJob: vi.fn(), postJob: vi.fn(), validateGig: vi.fn(),
  createAccount: vi.fn(), listAccounts: vi.fn(), provisionWalletInBackground: vi.fn(),
  getApplications: vi.fn(), getAccount: vi.fn(), getWorker: vi.fn(),
  hireWorker: vi.fn(), rejectWorker: vi.fn(), payWorker: vi.fn(), verifyPaymentCoverage: vi.fn(),
  apply: vi.fn(), startAssessment: vi.fn(), cancelAssessment: vi.fn(), timeRemaining: vi.fn(),
  gradeMcqAssessment: vi.fn(), gradeOralAssessment: vi.fn(),
  getBalance: vi.fn(), setSecurityPhrase: vi.fn(), listBeneficiaries: vi.fn(),
  saveBeneficiary: vi.fn(), armWithdrawal: vi.fn(), updateProfile: vi.fn(),
  addPreference: vi.fn(), removePreference: vi.fn(),
  listMessages: vi.fn(), sendMessage: vi.fn(), messagingUnlocked: vi.fn(),
  setExternalJobs: vi.fn(), trackExternalJob: vi.fn(), publishEvent: vi.fn(),
}));

vi.mock("../../lib/store", () => store);
vi.mock("../../lib/payments", () => ({ registerPayout: vi.fn(), confirmWithdrawal: vi.fn() }));
vi.mock("../../lib/external", () => ({ searchExternalJobs: vi.fn(async () => []) }));

const { makeTools } = await import("../../lib/agent/tools");

const worker = { id: "demo-worker", name: "Ada Okafor", role: "worker" as const, createdAt: 1, skills: ["transcription"], bio: "" };
const employer = { id: "u-emp", name: "ClearVoice Media", role: "employer" as const, createdAt: 1, skills: [], bio: "" };

const OWN_GIG = { id: "g-own", title: "Own gig", task: "t", skill: "transcription", pay: 12000, employer: "ClearVoice Media", requiresAssessment: false };
const OTHER_GIG = { id: "g-other", title: "Someone else's gig", task: "t", skill: "s", pay: 5000, employer: "Rival Media", requiresAssessment: false };

const run = (account: any, name: string, args: any = {}) => (makeTools(account) as any)[name].execute(args, {});

beforeEach(() => {
  vi.clearAllMocks();
  store.getWorker.mockReturnValue({ id: "demo-worker", name: "Ada Okafor", skills: [], bio: "", applications: [] });
  store.getJob.mockImplementation(async (id: string) =>
    id === "g-own" ? OWN_GIG : id === "g-other" ? OTHER_GIG : undefined,
  );
  store.listJobs.mockResolvedValue([OWN_GIG, OTHER_GIG]);
  store.getApplications.mockResolvedValue([]);
  store.messagingUnlocked.mockResolvedValue(true);
});

describe("employer-only actions are refused to workers", () => {
  // A worker who says "hire me for that job" must not be able to do it.
  const employerOnly: [string, any][] = [
    ["post_gig", { title: "x", skill: "y", pay: 1, requiresAssessment: false }],
    ["review_applicants", {}],
    ["hire_worker", { jobId: "g-own" }],
    ["reject_worker", { jobId: "g-own" }],
    ["mark_gig_paid", { jobId: "g-own" }],
  ];

  for (const [name, args] of employerOnly) {
    it(`refuses ${name}`, async () => {
      const r = await run(worker, name, args);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/only employer/i);
    });
  }

  it("does not touch any application when refusing", async () => {
    await run(worker, "hire_worker", { jobId: "g-own" });
    await run(worker, "mark_gig_paid", { jobId: "g-own" });
    expect(store.hireWorker).not.toHaveBeenCalled();
    expect(store.payWorker).not.toHaveBeenCalled();
  });
});

describe("employers cannot act on gigs that are not theirs", () => {
  // Ownership is checked by the gig's employer name, so a second employer
  // must not be able to hire, reject, or close out a rival's posting.
  for (const name of ["hire_worker", "reject_worker", "mark_gig_paid"]) {
    it(`refuses ${name} on another employer's gig`, async () => {
      const r = await run(employer, name, { jobId: "g-other" });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not one of this employer/i);
    });
  }

  it("performs no write when ownership fails", async () => {
    await run(employer, "hire_worker", { jobId: "g-other" });
    expect(store.hireWorker).not.toHaveBeenCalled();
  });
});

describe("marking a gig paid requires money to have actually arrived", () => {
  it("refuses when no confirmed payment covers it", async () => {
    store.verifyPaymentCoverage.mockResolvedValue({ ok: false, message: "No confirmed payment covers this gig yet." });
    const r = await run(employer, "mark_gig_paid", { jobId: "g-own" });
    expect(r.ok).toBe(false);
    expect(store.payWorker).not.toHaveBeenCalled();
  });

  it("allows it once the payment is confirmed", async () => {
    store.verifyPaymentCoverage.mockResolvedValue({ ok: true, message: "covered" });
    store.payWorker.mockResolvedValue({ id: "a1", jobId: "g-own", status: "paid", verified: true });
    const r = await run(employer, "mark_gig_paid", { jobId: "g-own" });
    expect(r.ok).toBe(true);
    expect(store.payWorker).toHaveBeenCalledWith("g-own");
  });

  it("checks coverage before writing, never after", async () => {
    store.verifyPaymentCoverage.mockResolvedValue({ ok: false, message: "nope" });
    await run(employer, "mark_gig_paid", { jobId: "g-own" });
    expect(store.verifyPaymentCoverage).toHaveBeenCalled();
    expect(store.payWorker).not.toHaveBeenCalled();
  });
});

describe("the onboarding channel stays shut until someone is hired", () => {
  it("refuses to read messages before a hire", async () => {
    store.messagingUnlocked.mockResolvedValue(false);
    const r = await run(worker, "read_messages", { jobId: "g-own" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/once the worker is hired/i);
  });

  it("refuses to send messages before a hire", async () => {
    // Otherwise it becomes a pre-hire back-channel that sidesteps assessment.
    store.messagingUnlocked.mockResolvedValue(false);
    const r = await run(employer, "send_message", { jobId: "g-own", text: "psst" });
    expect(r.ok).toBe(false);
    expect(store.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses an employer reading a thread on a gig they do not own", async () => {
    const r = await run(employer, "read_messages", { jobId: "g-other" });
    expect(r.ok).toBe(false);
    expect(store.listMessages).not.toHaveBeenCalled();
  });

  it("sends a message verbatim once unlocked", async () => {
    // Credentials pass through here and get read aloud — altering them would
    // hand the worker something that does not work.
    const secret = "Portal login: Ada_O / Tr0ub4dor&3";
    store.sendMessage.mockResolvedValue({});
    const r = await run(employer, "send_message", { jobId: "g-own", text: secret });
    expect(r.ok).toBe(true);
    expect(store.sendMessage).toHaveBeenCalledWith("g-own", "employer", "ClearVoice Media", secret);
  });

  it("refuses an empty message", async () => {
    const r = await run(worker, "send_message", { jobId: "g-own", text: "   " });
    expect(r.ok).toBe(false);
    expect(store.sendMessage).not.toHaveBeenCalled();
  });

  it("returns the jobId so the browser can open that thread", async () => {
    store.listMessages.mockResolvedValue([]);
    const r = await run(worker, "read_messages", { jobId: "g-own" });
    expect(r.jobId).toBe("g-own");
  });
});

describe("applying and assessments", () => {
  it("tells the model an assessment is needed so it can offer to start it", async () => {
    store.getJob.mockResolvedValue({ ...OWN_GIG, requiresAssessment: true });
    store.apply.mockResolvedValue({ id: "a1", jobId: "g-own", status: "applied", verified: false });
    const r = await run(worker, "apply_to_job", { jobId: "g-own" });
    expect(r.ok).toBe(true);
    expect(r.needsAssessment).toBe(true);
  });

  it("refuses to re-apply to a job whose assessment was cancelled", async () => {
    // The lockout the user was explicitly warned about.
    store.apply.mockResolvedValue({ id: "a1", jobId: "g-own", status: "cancelled", verified: false });
    const r = await run(worker, "apply_to_job", { jobId: "g-own" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cancelled/i);
  });

  it("refuses a job that does not exist", async () => {
    const r = await run(worker, "apply_to_job", { jobId: "ghost" });
    expect(r.ok).toBe(false);
    expect(store.apply).not.toHaveBeenCalled();
  });

  it("routes multiple-choice answers to the MCQ grader", async () => {
    store.gradeMcqAssessment.mockResolvedValue({ verified: true, score: 2, total: 2, message: "ok" });
    await run(worker, "submit_assessment", { jobId: "g-own", answers: [0, 1] });
    expect(store.gradeMcqAssessment).toHaveBeenCalledWith("demo-worker", "g-own", [0, 1]);
    expect(store.gradeOralAssessment).not.toHaveBeenCalled();
  });

  it("routes a spoken answer to the oral grader", async () => {
    store.gradeOralAssessment.mockResolvedValue({ verified: true, message: "ok" });
    await run(worker, "submit_assessment", { jobId: "g-own", answer: "I would listen first" });
    expect(store.gradeOralAssessment).toHaveBeenCalled();
    expect(store.gradeMcqAssessment).not.toHaveBeenCalled();
  });

  it("refuses a submission with neither answer form", async () => {
    const r = await run(worker, "submit_assessment", { jobId: "g-own" });
    expect(r.ok).toBe(false);
    expect(store.gradeMcqAssessment).not.toHaveBeenCalled();
    expect(store.gradeOralAssessment).not.toHaveBeenCalled();
  });

  it("reports remaining time truthfully rather than guessing", async () => {
    store.timeRemaining.mockResolvedValue({ limit: 300, remaining: 42 });
    const r = await run(worker, "assessment_time_left", { jobId: "g-own" });
    expect(r.remainingSeconds).toBe(42);
  });

  it("says so when there is no time limit, instead of inventing one", async () => {
    store.timeRemaining.mockResolvedValue(null);
    const r = await run(worker, "assessment_time_left", { jobId: "g-own" });
    expect(r.ok).toBe(false);
  });
});

describe("money tools", () => {
  it("only workers may set a spoken security phrase", async () => {
    const r = await run(employer, "set_security_phrase", { phrase: "sunny garden gate" });
    expect(r.ok).toBe(false);
    expect(store.setSecurityPhrase).not.toHaveBeenCalled();
  });

  it("passes the amount and destination straight through to the guarded arm step", async () => {
    store.armWithdrawal.mockResolvedValue({ ok: true, amount: 5000, accountName: "ADA OKAFOR", account: "1", mode: "passphrase" });
    await run(worker, "prepare_withdrawal", { amount: 5000, beneficiaryName: "Ada" });
    expect(store.armWithdrawal).toHaveBeenCalledWith("demo-worker", 5000, expect.objectContaining({ beneficiaryName: "Ada" }));
  });

  it("reports the balance from the tool result rather than any cached claim", async () => {
    store.getBalance.mockResolvedValue({ balance: 12000, account: "1234567890", bankName: "Wema Bank" });
    const r = await run(worker, "get_balance", {});
    expect(r.balance).toBe(12000);
    expect(r.currency).toBe("NGN");
  });
});

describe("preferences — Aide's only durable memory", () => {
  it("saves what the user asked to be remembered", async () => {
    store.addPreference.mockResolvedValue({ ok: true, added: true, preferences: ["I can only work mornings"] });
    const r = await run(worker, "remember_preference", { text: "I can only work mornings" });
    expect(r.ok).toBe(true);
    expect(store.addPreference).toHaveBeenCalledWith("demo-worker", "I can only work mornings");
  });

  it("does not duplicate something already remembered", async () => {
    store.addPreference.mockResolvedValue({ ok: true, added: false, preferences: ["x"] });
    const r = await run(worker, "remember_preference", { text: "x" });
    expect(r.saved).toBe(false);
  });

  it("forgets on request", async () => {
    store.removePreference.mockResolvedValue({ ok: true, removed: 1, preferences: [] });
    const r = await run(worker, "forget_preference", { text: "mornings" });
    expect(r.ok).toBe(true);
    expect(r.forgotten).toBe(1);
  });

  it("says so when there is nothing matching to forget", async () => {
    store.removePreference.mockResolvedValue({ ok: false, message: "No saved preference matches that." });
    const r = await run(worker, "forget_preference", { text: "never said this" });
    expect(r.ok).toBe(false);
  });
});

describe("finding work", () => {
  it("filters by keyword, pay range, and assessment requirement together", async () => {
    store.listJobs.mockResolvedValue([
      { id: "a", title: "Transcription work", skill: "transcription", pay: 15000, requiresAssessment: true },
      { id: "b", title: "Transcription work", skill: "transcription", pay: 5000, requiresAssessment: true },
      { id: "c", title: "Phone support", skill: "phone support", pay: 15000, requiresAssessment: true },
      { id: "d", title: "Transcription work", skill: "transcription", pay: 15000, requiresAssessment: false },
    ]);
    const r = await run(worker, "filter_jobs", { keyword: "transcription", minPay: 10000, maxPay: 20000, requiresAssessment: true });
    expect(r.matches.map((m: any) => m.id)).toEqual(["a"]);
  });

  it("returns everything when no filter is given", async () => {
    const r = await run(worker, "filter_jobs", {});
    expect(r.matches).toHaveLength(2);
  });

  it("is honest about finding nothing rather than widening silently", async () => {
    const r = await run(worker, "filter_jobs", { keyword: "astrophysics" });
    expect(r.matches).toEqual([]);
  });
});

describe("account switching", () => {
  it("never offers a password-protected account for voice switching", async () => {
    // Switching by voice must not be a way around someone's password.
    store.listAccounts.mockResolvedValue([
      { id: "u-real", name: "Real User", role: "worker", passwordHash: "x" },
      { id: "demo-employer", name: "ClearVoice Media", role: "employer" },
    ]);
    const r = await run(worker, "switch_account", { query: "Real User" });
    expect(r.ok).toBe(false);
  });

  it("asks which one when the name is ambiguous", async () => {
    store.listAccounts.mockResolvedValue([
      { id: "a", name: "Ada One", role: "worker" },
      { id: "b", name: "Ada Two", role: "worker" },
    ]);
    const r = await run(worker, "switch_account", { query: "ada" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/more than one/i);
  });

  it("switches on an unambiguous match", async () => {
    store.listAccounts.mockResolvedValue([{ id: "demo-employer", name: "ClearVoice Media", role: "employer" }]);
    const r = await run(worker, "switch_account", { query: "clearvoice" });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe("demo-employer");
  });
});

describe("navigation", () => {
  it("passes the page and section through for the browser to follow", async () => {
    const r = await run(worker, "open_page", { page: "payments", section: "history" });
    expect(r).toMatchObject({ ok: true, page: "payments", section: "history" });
  });
});
