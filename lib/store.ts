import { randomUUID } from "node:crypto";
import { createReservedAccount, getReservedAccount, getReservedAccountTransactions } from "./monnify";

// In-memory demo state. One seeded worker. Real Monnify reserved account +
// real balance from confirmed inbound payments. Swap for Convex/Postgres later.

export type McqQuestion = {
  question: string;
  options: string[];
  correctIndex: number;
};

export type Job = {
  id: string;
  title: string;
  task: string;
  skill: string;
  pay: number;
  employer: string;
  requiresAssessment: boolean;
  assessmentType?: "oral" | "mcq";
  // Employer-written spoken-assessment question; when absent, a generic
  // prompt is derived from the task.
  assessmentQuestion?: string;
  mcqQuestions?: McqQuestion[];
  timeLimit?: number; // in seconds (optional)
};
export type Application = { id: string; jobId: string; status: "applied" | "assessed" | "hired" | "paid"; verified: boolean };

// Accounts are demo-grade on purpose: a name and a chosen role, no passwords.
// The signed-in account travels in an `aide-user` cookie; unknown or absent
// ids fall back to the seeded demo worker so every flow still works cold.
export type Role = "worker" | "employer";
export type Account = { id: string; name: string; email?: string; role: Role; createdAt: number };

export function createAccount(name: string, role: Role, email?: string): Account {
  const acc: Account = { id: `u-${randomUUID().slice(0, 8)}`, name: name.trim(), email, role, createdAt: Date.now() };
  accounts.set(acc.id, acc);
  return acc;
}

export function getAccount(id?: string | null): Account {
  return (id && accounts.get(id)) || accounts.get("demo-worker")!;
}

// A record of money leaving via voice-confirmed withdrawal — Monnify has no
// cheap "list my disbursements" call, so the app keeps its own ledger.
export type WithdrawalRecord = { amount: number; accountName: string; status: string; at: number };

export function recordWithdrawal(r: Omit<WithdrawalRecord, "at">): void {
  withdrawals.push({ ...r, at: Date.now() });
}

export function getWithdrawals(): WithdrawalRecord[] {
  return [...withdrawals].sort((a, b) => b.at - a.at);
}

const SEED_JOBS: Job[] = [
  { id: "j1", title: "Audio transcription — 30 min interview", task: "Transcribe a 30-minute recorded interview into clean text.", skill: "transcription", pay: 12000, employer: "ClearVoice Media", requiresAssessment: true },
  { id: "j2", title: "Yoruba → English translation", task: "Translate 800 words of Yoruba text into English.", skill: "translation", pay: 15000, employer: "Lingua NG", requiresAssessment: true },
  { id: "j3", title: "Phone customer support — 2 hour shift", task: "Handle inbound support calls for an airtime vendor.", skill: "phone support", pay: 8000, employer: "TopUp Africa", requiresAssessment: true },
  { id: "j4", title: "Audio data labeling — 100 clips", task: "Listen to 100 short clips and tag the language spoken.", skill: "audio QA", pay: 10000, employer: "DataSeed", requiresAssessment: false },
];

type Worker = {
  id: string;
  name: string;
  email: string;
  skills: string[];
  bio: string;
  accountReference?: string;
  accountNumber?: string;
  bankName?: string;
  payoutAccount?: string;
  payoutBankCode?: string;
  payoutAccountName?: string;
  pendingWithdrawal?: PendingWithdrawal;
  applications: Application[];
};

// A withdrawal armed but not yet executed. The user must speak `phrase` back
// before the transfer runs — voice consent replacing a visual OTP.
export type PendingWithdrawal = { amount: number; phrase: string; createdAt: number };

const CONFIRM_WORDS = ["mango", "sunrise", "guitar", "river", "orange", "candle", "harvest", "compass"];
const PENDING_TTL_MS = 5 * 60 * 1000;

function makeConfirmPhrase(): string {
  return CONFIRM_WORDS[Math.floor(Math.random() * CONFIRM_WORDS.length)];
}

// Loose match: the user may say "mango" or "the word is mango". ASR is imperfect,
// so we check the confirm word appears among the spoken tokens.
function phraseMatches(spoken: string, phrase: string): boolean {
  return spoken
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .includes(phrase);
}

// All mutable state hangs off globalThis. Next.js dev bundles each API route
// separately, so a plain module-level singleton silently forks into one copy
// per route — applications created by /api/jobs/apply would be invisible to
// /api/jobs/status. globalThis is shared by the whole Node process.
type StoreState = { worker: Worker; accounts: Map<string, Account>; withdrawals: WithdrawalRecord[]; jobs: Job[]; attempts?: Map<string, number> };

function seedState(): StoreState {
  const w: Worker = {
    id: "demo-worker",
    name: "Aide Demo Worker",
    email: "aide-demo-worker@aide.test",
    skills: ["audio transcription", "translation", "data entry"],
    bio: "Experienced transcriber fluent in English and Yoruba. Detail-oriented and dedicated to delivering clean text under tight schedules.",
    applications: []
  };
  const accs = new Map<string, Account>();
  accs.set("demo-worker", { id: "demo-worker", name: w.name, email: w.email, role: "worker", createdAt: Date.now() });
  accs.set("demo-employer", { id: "demo-employer", name: "ClearVoice Media", role: "employer", createdAt: Date.now() });
  return { worker: w, accounts: accs, withdrawals: [], jobs: [...SEED_JOBS], attempts: new Map<string, number>() };
}

const g = globalThis as unknown as { __aideStore?: StoreState };
const state = (g.__aideStore ??= seedState());
// The state object can outlive code changes (HMR keeps globalThis) — backfill
// any fields added since it was first seeded.
state.jobs ??= [...SEED_JOBS];
state.withdrawals ??= [];
state.attempts ??= new Map<string, number>();
const worker = state.worker;
const accounts = state.accounts;
const withdrawals = state.withdrawals;
const JOBS = state.jobs;
const attempts = state.attempts;

// Post a new gig (employer flow — via the modal form or Aide's post_gig tool).
export function postJob(input: {
  title: string;
  skill: string;
  pay: number;
  employer: string;
  requiresAssessment: boolean;
  assessmentType?: "oral" | "mcq";
  assessmentQuestion?: string;
  mcqQuestions?: McqQuestion[];
  timeLimit?: number; // in seconds
  task?: string;
}): Job {
  const job: Job = {
    id: `g-${randomUUID().slice(0, 6)}`,
    title: input.title.trim(),
    task: input.task?.trim() || input.title.trim(),
    skill: input.skill.trim().toLowerCase(),
    pay: input.pay,
    employer: input.employer,
    requiresAssessment: input.requiresAssessment,
    assessmentType: input.requiresAssessment ? (input.assessmentType || "oral") : undefined,
    assessmentQuestion: input.assessmentQuestion?.trim() || undefined,
    mcqQuestions: input.mcqQuestions,
    timeLimit: input.timeLimit,
  };
  JOBS.push(job);
  return job;
}

// The spoken-assessment question: the employer's own wording when they gave
// one, otherwise derived from the task.
export function assessmentPromptFor(job: Job): string {
  return (
    job.assessmentQuestion ||
    `To verify your ${job.skill} skill: in one or two sentences, describe how you would approach this task — "${job.task}"`
  );
}

// The reference is deterministic so the same real NUBAN is reused across
// server restarts — Monnify allows only one reserved account per customer.
const ACCOUNT_REFERENCE = "aide-demo-worker";

// Lazily fetch (or create on very first run) the worker's real Monnify
// earnings account.
export async function ensureAccount(): Promise<Worker> {
  if (worker.accountNumber) return worker;
  let account;
  try {
    account = await getReservedAccount(ACCOUNT_REFERENCE);
  } catch {
    account = await createReservedAccount({
      accountReference: ACCOUNT_REFERENCE,
      accountName: worker.name,
      customerName: worker.name,
      customerEmail: worker.email,
    });
  }
  worker.accountReference = ACCOUNT_REFERENCE;
  worker.accountNumber = account.accounts[0].accountNumber;
  worker.bankName = account.accounts[0].bankName;
  return worker;
}

export function listJobs(skill?: string): Job[] {
  if (!skill) return JOBS;
  const q = skill.toLowerCase();
  return JOBS.filter((j) => j.skill.includes(q) || j.title.toLowerCase().includes(q));
}

export function getJob(id: string): Job | undefined {
  return JOBS.find((j) => j.id === id);
}

export function apply(jobId: string): Application {
  const existing = worker.applications.find((a) => a.jobId === jobId);
  if (existing) return existing;
  const app: Application = { id: randomUUID().slice(0, 8), jobId, status: "applied", verified: false };
  worker.applications = [...worker.applications, app];
  return app;
}

export function getApplications(): Application[] {
  return worker.applications;
}

// Attempt tracking helpers
export function recordAttempt(userId: string, jobId: string): number {
  const now = Date.now();
  attempts.set(`${userId}-${jobId}`, now);
  return now;
}

export function checkTimeLimit(userId: string, jobId: string, timeLimit?: number): { expired: boolean; elapsed: number; limit: number } {
  if (!timeLimit) return { expired: false, elapsed: 0, limit: 0 };
  const startedAt = attempts.get(`${userId}-${jobId}`);
  if (!startedAt) {
    // If no start record, be lenient for the demo but don't expire.
    return { expired: false, elapsed: 0, limit: timeLimit };
  }
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const GRACE_PERIOD = 10; // 10 seconds grace period
  const expired = elapsed > (timeLimit + GRACE_PERIOD);
  return { expired, elapsed, limit: timeLimit };
}

export function clearAttempt(userId: string, jobId: string) {
  attempts.delete(`${userId}-${jobId}`);
}

// How long the worker has left on a running, time-limited assessment — lets
// Aide answer "how much time do I have?" truthfully instead of guessing.
export function timeRemaining(userId: string, jobId: string): { limit: number; remaining: number } | null {
  const job = getJob(jobId);
  if (!job?.timeLimit) return null;
  const startedAt = attempts.get(`${userId}-${jobId}`);
  if (!startedAt) return null;
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return { limit: job.timeLimit, remaining: Math.max(0, job.timeLimit - elapsed) };
}

// Strip correctIndex from MCQ questions so they are hidden from workers/agents
export function publicJob(job: Job): Omit<Job, "mcqQuestions"> & { mcqQuestions?: Omit<McqQuestion, "correctIndex">[] } {
  const { mcqQuestions, ...rest } = job;
  return {
    ...rest,
    mcqQuestions: mcqQuestions?.map(({ question, options }) => ({ question, options })),
  };
}

// Grade a spoken assessment answer. Deliberately lenient: the bar is an
// on-topic, substantive spoken answer, not an essay.
export function gradeAssessment(jobId: string, answer: string): { verified: boolean; message: string } {
  return gradeOralAssessment("demo-worker", jobId, answer);
}

export function gradeOralAssessment(userId: string, jobId: string, answer: string): { verified: boolean; message: string } {
  const job = getJob(jobId);
  if (!job) return { verified: false, message: "Job not found." };
  
  const timeCheck = checkTimeLimit(userId, jobId, job.timeLimit);
  if (timeCheck.expired) {
    clearAttempt(userId, jobId);
    return { verified: false, message: `Time limit exceeded. You took ${timeCheck.elapsed} seconds, but the limit was ${timeCheck.limit} seconds.` };
  }
  
  clearAttempt(userId, jobId);
  const passed = answer.trim().split(/\s+/).length >= 8;
  if (passed) markVerified(jobId);
  return {
    verified: passed,
    message: passed ? "Skill verified." : "That answer was too brief — please say a bit more about how you would approach the task.",
  };
}

export function gradeMcqAssessment(userId: string, jobId: string, answers: number[]): { verified: boolean; score: number; total: number; message: string } {
  const job = getJob(jobId);
  if (!job) return { verified: false, score: 0, total: 0, message: "Job not found." };
  
  const timeCheck = checkTimeLimit(userId, jobId, job.timeLimit);
  if (timeCheck.expired) {
    clearAttempt(userId, jobId);
    return { verified: false, score: 0, total: 0, message: `Time limit exceeded. You took ${timeCheck.elapsed} seconds, but the limit was ${timeCheck.limit} seconds.` };
  }
  
  clearAttempt(userId, jobId);
  const questions = job.mcqQuestions || [];
  if (questions.length === 0) {
    return { verified: false, score: 0, total: 0, message: "This job does not have MCQ questions." };
  }
  
  let correctCount = 0;
  questions.forEach((q, i) => {
    if (answers[i] === q.correctIndex) {
      correctCount++;
    }
  });
  
  const scorePct = (correctCount / questions.length) * 100;
  const passed = scorePct >= 70;
  
  if (passed) markVerified(jobId);
  return {
    verified: passed,
    score: correctCount,
    total: questions.length,
    message: passed 
      ? `Skill verified. You scored ${correctCount} out of ${questions.length} correct.` 
      : `You scored ${correctCount} out of ${questions.length} correct. That is below the 70% passing threshold. Please try again.`,
  };
}

export function markVerified(jobId: string): Application | undefined {
  const app = worker.applications.find((a) => a.jobId === jobId);
  if (app) {
    app.verified = true;
    app.status = "assessed";
  }
  return app;
}

export function hireWorker(jobId: string): Application | undefined {
  const app = worker.applications.find((a) => a.jobId === jobId);
  if (app) {
    app.status = "hired";
  }
  return app;
}

export function payWorker(jobId: string): Application | undefined {
  const app = worker.applications.find((a) => a.jobId === jobId);
  if (app) {
    app.status = "paid";
  }
  return app;
}

export function setPayout(account: string, bankCode: string, accountName: string): void {
  worker.payoutAccount = account;
  worker.payoutBankCode = bankCode;
  worker.payoutAccountName = accountName;
}

export function updateProfile(
  userId: string,
  input: { name?: string; email?: string; skills?: string[]; bio?: string }
): { account: Account | undefined; worker: Worker } {
  const acc = accounts.get(userId);
  if (acc) {
    if (input.name !== undefined) acc.name = input.name.trim();
    if (input.email !== undefined) acc.email = input.email.trim();
  }
  
  if (userId === "demo-worker" || acc?.role === "worker") {
    if (input.name !== undefined) worker.name = input.name.trim();
    if (input.email !== undefined) worker.email = input.email.trim();
    if (input.skills !== undefined) {
      worker.skills = input.skills.map((s) => s.trim()).filter(Boolean);
    }
    if (input.bio !== undefined) worker.bio = input.bio.trim();
  }
  return { account: acc, worker };
}

// Step 1 of withdrawal: arm it. Returns the details Aide must read back plus the
// confirm word the user must speak. No money moves here.
export function armWithdrawal(amount: number):
  | { ok: true; amount: number; accountName: string; account: string; phrase: string }
  | { ok: false; message: string } {
  if (!worker.payoutAccount || !worker.payoutBankCode || !worker.payoutAccountName) {
    return { ok: false, message: "No payout account saved yet. Register one first." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Amount must be a positive number." };
  }
  const phrase = makeConfirmPhrase();
  worker.pendingWithdrawal = { amount, phrase, createdAt: Date.now() };
  return { ok: true, amount, accountName: worker.payoutAccountName, account: worker.payoutAccount, phrase };
}

// Step 2 of withdrawal: verify the spoken confirmation against the armed phrase.
// Only a match (within TTL) authorizes the transfer. This is the accessible 2FA gate.
export function verifyWithdrawal(spokenPhrase: string):
  | { ok: true; amount: number; account: string; bankCode: string; accountName: string }
  | { ok: false; message: string } {
  const pending = worker.pendingWithdrawal;
  if (!pending) return { ok: false, message: "No withdrawal is awaiting confirmation. Start one first." };
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    worker.pendingWithdrawal = undefined;
    return { ok: false, message: "The confirmation timed out. Please start the withdrawal again." };
  }
  if (!phraseMatches(spokenPhrase, pending.phrase)) {
    return { ok: false, message: `That didn't match. Ask them to say the word "${pending.phrase}" to confirm.` };
  }
  worker.pendingWithdrawal = undefined;
  return {
    ok: true,
    amount: pending.amount,
    account: worker.payoutAccount!,
    bankCode: worker.payoutBankCode!,
    accountName: worker.payoutAccountName!,
  };
}

// Real balance: sum of PAID inbound payments to the reserved account.
export async function getBalance(): Promise<{ balance: number; account?: string }> {
  await ensureAccount();
  if (!worker.accountReference) return { balance: 0 };
  const { content } = await getReservedAccountTransactions(worker.accountReference);
  const balance = content.filter((t) => t.paymentStatus === "PAID").reduce((s, t) => s + t.amount, 0);
  return { balance, account: worker.accountNumber };
}

export function snapshot() {
  return {
    accountNumber: worker.accountNumber,
    bankName: worker.bankName,
    payoutAccountName: worker.payoutAccountName,
    awaitingWithdrawalConfirmation: worker.pendingWithdrawal
      ? { amount: worker.pendingWithdrawal.amount }
      : undefined,
    // Sanitized: this snapshot travels to the browser with every agent reply,
    // so MCQ correct answers must never be in it.
    applications: worker.applications.map((a) => {
      const job = getJob(a.jobId);
      return { ...a, job: job ? publicJob(job) : undefined };
    }),
    jobs: JOBS.map(publicJob),
  };
}

export function getWorker(): Worker {
  return worker;
}
