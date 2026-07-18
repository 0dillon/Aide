import { apply, getJob } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { jobId } = (await req.json().catch(() => ({}))) as { jobId?: string };
  const job = jobId ? getJob(jobId) : undefined;
  if (!job) return Response.json({ error: "No job with that id." }, { status: 400 });
  const app = apply(job.id);
  return Response.json({ ok: true, application: app, requiresAssessment: job.requiresAssessment });
}
