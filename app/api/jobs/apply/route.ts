import { apply, getAccount, getJob, unapply } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const { jobId } = (await req.json().catch(() => ({}))) as { jobId?: string };
  const job = jobId ? await getJob(jobId) : undefined;
  if (!job) return Response.json({ error: "No job with that id." }, { status: 400 });
  const app = await apply(acc.id, job.id);
  if (app.status === "cancelled") {
    return Response.json({ error: "You cancelled the assessment for this job earlier, so you can no longer apply to it." }, { status: 403 });
  }
  return Response.json({ ok: true, application: app, requiresAssessment: job.requiresAssessment });
}

// Withdraw an application. Allowed only while it is still just an application:
// once the assessment has started there is a record of an attempt, and letting
// it be deleted would be a way to quietly retake a test meant to be taken once.
export async function DELETE(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) return Response.json({ error: "jobId is required." }, { status: 400 });
  const r = await unapply(acc.id, jobId);
  return Response.json(r.ok ? { ok: true, message: r.message } : { error: r.message }, { status: r.ok ? 200 : 409 });
}
