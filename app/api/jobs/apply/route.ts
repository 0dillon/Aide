import { apply, getJob } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { jobId } = (await req.json().catch(() => ({}))) as { jobId?: string };
  const job = jobId ? await getJob(jobId) : undefined;
  if (!job) return Response.json({ error: "No job with that id." }, { status: 400 });
  const app = await apply(job.id);
  if (app.status === "cancelled") {
    return Response.json({ error: "You cancelled the assessment for this job earlier, so you can no longer apply to it." }, { status: 403 });
  }
  return Response.json({ ok: true, application: app, requiresAssessment: job.requiresAssessment });
}
