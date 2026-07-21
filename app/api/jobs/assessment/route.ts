import { cancelAssessment, getJob, gradeOralAssessment, gradeMcqAssessment, startAssessment } from "@/lib/store";
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
  const job = jobId ? await getJob(jobId) : undefined;
  if (!job) return Response.json({ error: "No job with that id." }, { status: 400 });

  // Cancellation: one-way lockout.
  if (action === "cancel") {
    await cancelAssessment(userId, job.id);
    return Response.json({ ok: true, cancelled: true });
  }

  // MCQ Grading
  if (answers !== undefined && Array.isArray(answers)) {
    return Response.json({ ok: true, ...(await gradeMcqAssessment(userId, job.id, answers)) });
  }

  // Oral Grading
  if (answer !== undefined && typeof answer === "string") {
    return Response.json({ ok: true, ...(await gradeOralAssessment(userId, job.id, answer)) });
  }

  // Start Assessment — shared with the voice agent's start_assessment tool,
  // so the cancel lockout and attempt bookkeeping live in one place.
  const started = await startAssessment(userId, job.id);
  if (!started.ok) {
    return Response.json({ error: started.message }, { status: 403 });
  }
  return Response.json(started);
}
