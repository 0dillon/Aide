import { getAccount, postJob, validateGig, type McqQuestion, deletePostedJob } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Employers post gigs here — from the modal form or anywhere else. The voice
// path goes through the agent's post_gig tool; both validate through the same
// validateGig() so a gig accepted by voice is accepted on screen and vice versa.
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
    timeLimit?: number;
    task?: string;
  };

  const v = validateGig(body);
  if (!v.ok) return Response.json({ error: v.message }, { status: 400 });

  const job = await postJob({ ...v.gig, employer: acc.name, employerAccountId: acc.id });
  return Response.json({ ok: true, job });
}

// Take down a gig you posted. Refused once anyone has been hired or paid on
// it: at that point the gig is the record of work that was agreed, and removing
// it would strand the worker's application and their onboarding thread.
export async function DELETE(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  if (acc.role !== "employer") {
    return Response.json({ error: "Only employers can remove gigs." }, { status: 403 });
  }
  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) return Response.json({ error: "jobId is required." }, { status: 400 });
  const r = await deletePostedJob(acc.id, jobId);
  return Response.json(r.ok ? { ok: true, message: r.message } : { error: r.message }, { status: r.ok ? 200 : 403 });
}
