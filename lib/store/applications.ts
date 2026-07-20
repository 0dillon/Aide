import { attempts, JOBS, newId, worker, type Application, type Job, type McqQuestion } from "./state";
import { assessmentPromptFor, getJob, publicJob } from "./jobs";
import { getBalance, getWallet } from "./payments";

export function apply(jobId: string): Application {
  const existing = worker.applications.find((a) => a.jobId === jobId);
  if (existing) return existing;
  const app: Application = { id: newId(), jobId, status: "applied", verified: false };
  worker.applications = [...worker.applications, app];
  return app;
}

export function getApplications(): Application[] {
  return worker.applications;
}

export function getApplication(jobId: string): Application | undefined {
  return worker.applications.find((a) => a.jobId === jobId);
}

// --- Assessment attempts and time limits ---

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
  const expired = elapsed > timeLimit + GRACE_PERIOD;
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

// The single entry point for beginning an assessment — used by both the voice
// agent's start_assessment tool and the jobs page's API route, so the rules
// (cancel lockout, attempt timestamps, MCQ sanitizing) live in exactly one place.
export type AssessmentStart =
  | { ok: false; message: string }
  | { ok: true; jobId: string; assessmentType: "mcq"; questions: Omit<McqQuestion, "correctIndex">[]; timeLimit?: number; startedAt: number }
  | { ok: true; jobId: string; assessmentType: "oral"; prompt: string; timeLimit?: number; startedAt: number };

export function startAssessment(userId: string, jobId: string): AssessmentStart {
  const job = getJob(jobId);
  if (!job) return { ok: false, message: "No job with that id." };
  if (getApplication(jobId)?.status === "cancelled") {
    return { ok: false, message: "The worker cancelled this assessment earlier and cannot retake it or apply to this job again." };
  }
  const startedAt = recordAttempt(userId, jobId);
  if ((job.assessmentType || "oral") === "mcq") {
    const questions = job.mcqQuestions?.map(({ question, options }) => ({ question, options })) || [];
    return { ok: true, jobId: job.id, assessmentType: "mcq", questions, timeLimit: job.timeLimit, startedAt };
  }
  return { ok: true, jobId: job.id, assessmentType: "oral", prompt: assessmentPromptFor(job), timeLimit: job.timeLimit, startedAt };
}

// The worker walked away from an assessment. This is deliberately one-way:
// the application flips to "cancelled" and stays there, so the job can never
// be re-applied to or the assessment retaken.
export function cancelAssessment(userId: string, jobId: string): Application | undefined {
  clearAttempt(userId, jobId);
  const app = getApplication(jobId);
  if (app && app.status === "applied" && !app.verified) {
    app.status = "cancelled";
    app.assessmentResult = "Assessment cancelled by worker";
  }
  return app;
}

// --- Grading ---

export async function gradeOralAssessment(userId: string, jobId: string, answer: string): Promise<{ verified: boolean; message: string }> {
  const job = getJob(jobId);
  if (!job) return { verified: false, message: "Job not found." };

  const timeCheck = checkTimeLimit(userId, jobId, job.timeLimit);
  if (timeCheck.expired) {
    clearAttempt(userId, jobId);
    return { verified: false, message: `Time limit exceeded. You took ${timeCheck.elapsed} seconds, but the limit was ${timeCheck.limit} seconds.` };
  }

  clearAttempt(userId, jobId);
  // Rubric grading by the model (fair, unbiased, no answer reveals); falls
  // back to a length heuristic when no model is available.
  const { gradeOral } = await import("../grading");
  const result = await gradeOral(job, answer);
  if (result.verified) markVerified(jobId);
  recordAssessmentResult(jobId, result.verified ? "Oral assessment: passed" : "Oral assessment: not passed");
  return result;
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
    if (answers[i] === q.correctIndex) correctCount++;
  });

  const scorePct = (correctCount / questions.length) * 100;
  const passed = scorePct >= 70;

  if (passed) markVerified(jobId);
  recordAssessmentResult(jobId, `MCQ: ${correctCount} of ${questions.length} (${Math.round(scorePct)}%)`);
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

export function markVerified(jobId: string): Application | undefined {
  const app = getApplication(jobId);
  if (app) {
    app.verified = true;
    app.status = "assessed";
  }
  return app;
}

export function hireWorker(jobId: string): Application | undefined {
  const app = getApplication(jobId);
  if (app) app.status = "hired";
  return app;
}

export function rejectWorker(jobId: string): Application | undefined {
  const app = getApplication(jobId);
  if (app) app.status = "rejected";
  return app;
}

export function payWorker(jobId: string): Application | undefined {
  const app = getApplication(jobId);
  if (app) app.status = "paid";
  return app;
}

// Attach a readable assessment outcome to the application so the employer
// can see how the applicant actually did.
export function recordAssessmentResult(jobId: string, text: string): void {
  const app = getApplication(jobId);
  if (app) app.assessmentResult = text;
}

// Payment truth: a gig may only be marked paid when confirmed inbound money
// (real, from Monnify) covers it on top of everything already claimed by
// other paid gigs. The button obeys the same rule as the model: never state
// a payment that didn't verifiably happen.
export async function verifyPaymentCoverage(jobId: string): Promise<{ ok: boolean; message: string }> {
  const job = getJob(jobId);
  if (!job) return { ok: false, message: "No job with that id." };
  // Applications belong to the demo worker, so coverage is checked against
  // that worker's own wallet — inbound pay must land in THEIR account.
  const { balance } = await getBalance(worker.id);
  const alreadyClaimed = worker.applications
    .filter((a) => a.status === "paid")
    .reduce((s, a) => s + (getJob(a.jobId)?.pay ?? 0), 0);
  if (balance >= alreadyClaimed + job.pay) return { ok: true, message: "Confirmed payment covers this gig." };
  const short = alreadyClaimed + job.pay - balance;
  return {
    ok: false,
    message: `No confirmed payment covers this gig yet. The worker's confirmed inbound total is ${balance} naira and ${alreadyClaimed} naira is already claimed by other paid gigs — ${short} naira more must land first. Send the pay from the payout desk, then try again.`,
  };
}

// Everything the browser may know, sanitized: this snapshot travels to the
// client with every agent reply, so MCQ correct answers must never be in it.
export function snapshot(accountId: string) {
  const wallet = getWallet(accountId);
  return {
    accountNumber: wallet.accountNumber,
    bankName: wallet.bankName,
    payoutAccountName: wallet.payoutAccountName,
    awaitingWithdrawalConfirmation: wallet.pendingWithdrawal ? { amount: wallet.pendingWithdrawal.amount } : undefined,
    applications: worker.applications.map((a) => {
      const job = getJob(a.jobId);
      return { ...a, job: job ? publicJob(job) : undefined };
    }),
    jobs: JOBS.map(publicJob),
  };
}
