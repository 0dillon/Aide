import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { JOBS, worker, type Application, type McqQuestion } from "./state";
import { assessmentPromptFor, getJob, listJobs, publicJob } from "./jobs";
import { getBalance, getWallet } from "./payments";

// Applications live in Convex so the worker↔employer loop (apply → assessed →
// hired/rejected/paid) is visible to both parties no matter which serverless
// instance served either request. Applications belong to the demo worker, as
// before — `worker.id` is the owning account.

type AppDoc = { _id: string; accountId: string; jobId: string; status: Application["status"]; verified: boolean; assessmentResult?: string };

function toApplication(d: AppDoc): Application {
  return { id: d._id, jobId: d.jobId, status: d.status, verified: d.verified, assessmentResult: d.assessmentResult };
}

const owner = () => worker.id;

export async function apply(jobId: string): Promise<Application> {
  const d = (await convexClient().mutation(api.applications.apply, { accountId: owner(), jobId })) as AppDoc;
  return toApplication(d);
}

export async function getApplications(): Promise<Application[]> {
  const docs = (await convexClient().query(api.applications.listForAccount, { accountId: owner() })) as AppDoc[];
  return docs.map(toApplication);
}

export async function getApplication(jobId: string): Promise<Application | undefined> {
  const d = (await convexClient().query(api.applications.getForJob, { accountId: owner(), jobId })) as AppDoc | null;
  return d ? toApplication(d) : undefined;
}

async function patch(
  jobId: string,
  fields: { status?: Application["status"]; verified?: boolean; assessmentResult?: string; requireStatus?: Application["status"]; requireUnverified?: boolean },
): Promise<Application | undefined> {
  const d = (await convexClient().mutation(api.applications.setStatus, { accountId: owner(), jobId, ...fields })) as AppDoc | null;
  return d ? toApplication(d) : undefined;
}

// --- Assessment attempts and time limits ---

const attemptKey = (userId: string, jobId: string) => `${userId}-${jobId}`;

export async function recordAttempt(userId: string, jobId: string): Promise<number> {
  const now = Date.now();
  await convexClient().mutation(api.jobs.recordAttempt, { key: attemptKey(userId, jobId), startedAt: now });
  return now;
}

export async function checkTimeLimit(
  userId: string,
  jobId: string,
  timeLimit?: number,
): Promise<{ expired: boolean; elapsed: number; limit: number }> {
  if (!timeLimit) return { expired: false, elapsed: 0, limit: 0 };
  const startedAt = (await convexClient().query(api.jobs.getAttempt, { key: attemptKey(userId, jobId) })) as number | null;
  if (!startedAt) {
    // If no start record, be lenient for the demo but don't expire.
    return { expired: false, elapsed: 0, limit: timeLimit };
  }
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const GRACE_PERIOD = 10; // 10 seconds grace period
  const expired = elapsed > timeLimit + GRACE_PERIOD;
  return { expired, elapsed, limit: timeLimit };
}

export async function clearAttempt(userId: string, jobId: string): Promise<void> {
  await convexClient().mutation(api.jobs.clearAttempt, { key: attemptKey(userId, jobId) });
}

// How long the worker has left on a running, time-limited assessment — lets
// Aide answer "how much time do I have?" truthfully instead of guessing.
export async function timeRemaining(userId: string, jobId: string): Promise<{ limit: number; remaining: number } | null> {
  const job = await getJob(jobId);
  if (!job?.timeLimit) return null;
  const startedAt = (await convexClient().query(api.jobs.getAttempt, { key: attemptKey(userId, jobId) })) as number | null;
  if (!startedAt) return null;
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return { limit: job.timeLimit, remaining: Math.max(0, job.timeLimit - elapsed) };
}

// The single entry point for beginning an assessment — used by both the voice
// agent's start_assessment tool and the jobs page's API route, so the rules
// (cancel lockout, attempt timestamps, MCQ sanitizing) live in exactly one place.
export type AssessmentStart =
  | { ok: false; message: string }
  | { ok: true; jobId: string; assessmentType: "mcq"; questions: Omit<McqQuestion, "correctIndex">[]; timeLimit?: number; startedAt: number }
  | { ok: true; jobId: string; assessmentType: "oral"; prompt: string; timeLimit?: number; startedAt: number };

export async function startAssessment(userId: string, jobId: string): Promise<AssessmentStart> {
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "No job with that id." };
  if ((await getApplication(jobId))?.status === "cancelled") {
    return { ok: false, message: "The worker cancelled this assessment earlier and cannot retake it or apply to this job again." };
  }
  const startedAt = await recordAttempt(userId, jobId);
  if ((job.assessmentType || "oral") === "mcq") {
    const questions = job.mcqQuestions?.map(({ question, options }) => ({ question, options })) || [];
    return { ok: true, jobId: job.id, assessmentType: "mcq", questions, timeLimit: job.timeLimit, startedAt };
  }
  return { ok: true, jobId: job.id, assessmentType: "oral", prompt: assessmentPromptFor(job), timeLimit: job.timeLimit, startedAt };
}

// The worker walked away from an assessment. This is deliberately one-way:
// the application flips to "cancelled" and stays there, so the job can never
// be re-applied to or the assessment retaken. The guard is enforced inside the
// Convex mutation, so a concurrent grade-pass can't race it.
export async function cancelAssessment(userId: string, jobId: string): Promise<Application | undefined> {
  await clearAttempt(userId, jobId);
  return patch(jobId, {
    status: "cancelled",
    assessmentResult: "Assessment cancelled by worker",
    requireStatus: "applied",
    requireUnverified: true,
  });
}

// --- Grading ---

export async function gradeOralAssessment(userId: string, jobId: string, answer: string): Promise<{ verified: boolean; message: string }> {
  const job = await getJob(jobId);
  if (!job) return { verified: false, message: "Job not found." };

  const timeCheck = await checkTimeLimit(userId, jobId, job.timeLimit);
  if (timeCheck.expired) {
    await clearAttempt(userId, jobId);
    return { verified: false, message: `Time limit exceeded. You took ${timeCheck.elapsed} seconds, but the limit was ${timeCheck.limit} seconds.` };
  }

  await clearAttempt(userId, jobId);
  // Rubric grading by the model (fair, unbiased, no answer reveals); falls
  // back to a length heuristic when no model is available.
  const { gradeOral } = await import("../grading");
  const result = await gradeOral(job, answer);
  if (result.verified) await markVerified(jobId);
  await recordAssessmentResult(jobId, result.verified ? "Oral assessment: passed" : "Oral assessment: not passed");
  return result;
}

export async function gradeMcqAssessment(
  userId: string,
  jobId: string,
  answers: number[],
): Promise<{ verified: boolean; score: number; total: number; message: string }> {
  const job = await getJob(jobId);
  if (!job) return { verified: false, score: 0, total: 0, message: "Job not found." };

  const timeCheck = await checkTimeLimit(userId, jobId, job.timeLimit);
  if (timeCheck.expired) {
    await clearAttempt(userId, jobId);
    return { verified: false, score: 0, total: 0, message: `Time limit exceeded. You took ${timeCheck.elapsed} seconds, but the limit was ${timeCheck.limit} seconds.` };
  }

  await clearAttempt(userId, jobId);
  const questions = job.mcqQuestions || [];
  if (questions.length === 0) {
    return { verified: false, score: 0, total: 0, message: "This job does not have MCQ questions." };
  }

  let correctCount = 0;
  questions.forEach((q, i) => {
    if (answers[i] === q.correctIndex) correctCount++;
  });

  const scorePct = (correctCount / questions.length) * 100;
  const passed = scorePct >= 70;

  if (passed) await markVerified(jobId);
  await recordAssessmentResult(jobId, `MCQ: ${correctCount} of ${questions.length} (${Math.round(scorePct)}%)`);
  return {
    verified: passed,
    score: correctCount,
    total: questions.length,
    message: passed
      ? `Skill verified. You scored ${correctCount} out of ${questions.length} correct.`
      : `You scored ${correctCount} out of ${questions.length} correct. That is below the 70% passing threshold. Please try again.`,
  };
}

// --- Status transitions ---

export const markVerified = (jobId: string) => patch(jobId, { verified: true, status: "assessed" });
export const hireWorker = (jobId: string) => patch(jobId, { status: "hired" });
export const rejectWorker = (jobId: string) => patch(jobId, { status: "rejected" });
export const payWorker = (jobId: string) => patch(jobId, { status: "paid" });

// Attach a readable assessment outcome to the application so the employer
// can see how the applicant actually did.
export async function recordAssessmentResult(jobId: string, text: string): Promise<void> {
  await patch(jobId, { assessmentResult: text });
}

// Payment truth: a gig may only be marked paid when confirmed inbound money
// (real, from Monnify) covers it on top of everything already claimed by
// other paid gigs. The button obeys the same rule as the model: never state
// a payment that didn't verifiably happen.
export async function verifyPaymentCoverage(jobId: string): Promise<{ ok: boolean; message: string }> {
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "No job with that id." };
  // Applications belong to the demo worker, so coverage is checked against
  // that worker's own wallet — inbound pay must land in THEIR account.
  const { balance } = await getBalance(worker.id);
  const apps = await getApplications();
  const paid = apps.filter((a) => a.status === "paid");
  let alreadyClaimed = 0;
  for (const a of paid) alreadyClaimed += (await getJob(a.jobId))?.pay ?? 0;
  if (balance >= alreadyClaimed + job.pay) return { ok: true, message: "Confirmed payment covers this gig." };
  const short = alreadyClaimed + job.pay - balance;
  return {
    ok: false,
    message: `No confirmed payment covers this gig yet. The worker's confirmed inbound total is ${balance} naira and ${alreadyClaimed} naira is already claimed by other paid gigs — ${short} naira more must land first. Send the pay from the payout desk, then try again.`,
  };
}

// Everything the browser may know, sanitized: this snapshot travels to the
// client with every agent reply, so MCQ correct answers must never be in it.
export async function snapshot(accountId: string) {
  const [wallet, apps, jobs] = await Promise.all([getWallet(accountId), getApplications(), listJobs()]);
  const applications = [];
  for (const a of apps) {
    const job = await getJob(a.jobId);
    applications.push({ ...a, job: job ? publicJob(job) : undefined });
  }
  return {
    accountNumber: wallet.accountNumber,
    bankName: wallet.bankName,
    payoutAccountName: wallet.payoutAccountName,
    awaitingWithdrawalConfirmation: wallet.pendingWithdrawal ? { amount: wallet.pendingWithdrawal.amount } : undefined,
    applications,
    jobs: jobs.map(publicJob),
  };
}
