import { apply, getAccount, getJob } from "@/lib/store";
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
