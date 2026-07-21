import { getAccount, postJob, type McqQuestion } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Employers post gigs here — from the modal form or anywhere else. The voice
// path goes through the agent's post_gig tool, which calls the same postJob.
export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  if (acc.role !== "employer") {
    return Response.json({ error: "Only employer accounts can post gigs." }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    skill?: string;
    pay?: number;
    requiresAssessment?: boolean;
    assessmentType?: "oral" | "mcq";
    assessmentQuestion?: string;
    mcqQuestions?: McqQuestion[];
    timeLimit?: number; // in seconds
    task?: string;
  };
  if (!body.title?.trim()) return Response.json({ error: "A gig title is required." }, { status: 400 });
  if (!body.skill?.trim()) return Response.json({ error: "A gig type or skill is required." }, { status: 400 });
  const pay = Number(body.pay);
  if (!Number.isFinite(pay) || pay <= 0) return Response.json({ error: "Pay must be a positive amount in Naira." }, { status: 400 });

  let timeLimit: number | undefined = undefined;
  if (body.timeLimit !== undefined) {
    timeLimit = Number(body.timeLimit);
    if (!Number.isInteger(timeLimit) || timeLimit <= 0 || timeLimit > 3600) {
      return Response.json({ error: "Time limit must be a positive integer up to 3600 seconds (1 hour)." }, { status: 400 });
    }
  }

  let mcqQuestions: McqQuestion[] | undefined = undefined;
  if (body.requiresAssessment && body.assessmentType === "mcq") {
    if (!Array.isArray(body.mcqQuestions) || body.mcqQuestions.length === 0) {
      return Response.json({ error: "At least one question is required for multiple choice assessments." }, { status: 400 });
    }
    if (body.mcqQuestions.length > 10) {
      return Response.json({ error: "A maximum of 10 questions is allowed." }, { status: 400 });
    }
    
    // Validate each question
    for (let i = 0; i < body.mcqQuestions.length; i++) {
      const q = body.mcqQuestions[i];
      if (!q.question?.trim()) {
        return Response.json({ error: `Question ${i + 1} has no text.` }, { status: 400 });
      }
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) {
        return Response.json({ error: `Question ${i + 1} must have between 2 and 6 options.` }, { status: 400 });
      }
      for (let j = 0; j < q.options.length; j++) {
        if (!q.options[j]?.trim()) {
          return Response.json({ error: `Question ${i + 1}, Option ${j + 1} is empty.` }, { status: 400 });
        }
      }
      const idx = Number(q.correctIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) {
        return Response.json({ error: `Question ${i + 1} must have a valid correct index (0 to ${q.options.length - 1}).` }, { status: 400 });
      }
    }
    mcqQuestions = body.mcqQuestions.map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      correctIndex: Number(q.correctIndex),
    }));
  }

  const job = await postJob({
    title: body.title,
    skill: body.skill,
    pay,
    employer: acc.name,
    requiresAssessment: !!body.requiresAssessment,
    assessmentType: body.assessmentType,
    assessmentQuestion: body.assessmentQuestion,
    mcqQuestions,
    timeLimit,
    task: body.task,
  });
  return Response.json({ ok: true, job });
}
