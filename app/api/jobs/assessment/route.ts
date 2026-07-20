import { assessmentPromptFor, getJob, gradeOralAssessment, gradeMcqAssessment, recordAttempt, getAccount } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// One endpoint, three moves:
//   1. POST { jobId } starts the assessment (stores attempt timestamp, returns prompt/questions)
//   2. POST { jobId, answer } grades the worker's spoken oral answer
//   3. POST { jobId, answers } grades the worker's MCQ answers (array of option indices)
export async function POST(req: Request) {
  const userId = userIdFrom(req) || "demo-worker";
  const body = (await req.json().catch(() => ({}))) as {
    jobId?: string;
    answer?: string; // spoken text for oral
    answers?: number[]; // indices for MCQ
  };
  
  const { jobId, answer, answers } = body;
  const job = jobId ? getJob(jobId) : undefined;
  if (!job) return Response.json({ error: "No job with that id." }, { status: 400 });

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
