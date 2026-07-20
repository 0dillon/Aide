import { assessmentPromptFor, cancelAssessment, getApplications, getJob, gradeOralAssessment, gradeMcqAssessment, recordAttempt } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// One endpoint, four moves:
//   1. POST { jobId } starts the assessment (stores attempt timestamp, returns prompt/questions)
//   2. POST { jobId, answer } grades the worker's spoken oral answer
//   3. POST { jobId, answers } grades the worker's MCQ answers (array of option indices)
//   4. POST { jobId, action: "cancel" } cancels — permanently locking the job for this worker
export async function POST(req: Request) {
  const userId = userIdFrom(req) || "demo-worker";
  const body = (await req.json().catch(() => ({}))) as {
    jobId?: string;
    answer?: string; // spoken text for oral
    answers?: number[]; // indices for MCQ
    action?: string;
  };

  const { jobId, answer, answers, action } = body;
  const job = jobId ? getJob(jobId) : undefined;
  if (!job) return Response.json({ error: "No job with that id." }, { status: 400 });

  // Cancellation: one-way lockout.
  if (action === "cancel") {
    cancelAssessment(userId, job.id);
    return Response.json({ ok: true, cancelled: true });
  }

  const app = getApplications().find((a) => a.jobId === job.id);
  if (app?.status === "cancelled") {
    return Response.json({ error: "You cancelled this assessment earlier, so this job is no longer open to you." }, { status: 403 });
  }

  // MCQ Grading
  if (answers !== undefined && Array.isArray(answers)) {
    return Response.json({ ok: true, ...gradeMcqAssessment(userId, job.id, answers) });
  }

  // Oral Grading
  if (answer !== undefined && typeof answer === "string") {
    return Response.json({ ok: true, ...(await gradeOralAssessment(userId, job.id, answer)) });
  }

  // Start Assessment (fetch questions/prompt and record start timestamp)
  const startTime = recordAttempt(userId, job.id);
  const type = job.assessmentType || "oral";
  const timeLimit = job.timeLimit; // in seconds

  if (type === "mcq") {
    const sanitizedQuestions = job.mcqQuestions?.map(({ question, options }) => ({ question, options })) || [];
    return Response.json({
      ok: true,
      assessmentType: "mcq",
      questions: sanitizedQuestions,
      timeLimit,
      startedAt: startTime,
    });
  } else {
    const prompt = assessmentPromptFor(job);
    return Response.json({
      ok: true,
      assessmentType: "oral",
      prompt,
      timeLimit,
      startedAt: startTime,
    });
  }
}
