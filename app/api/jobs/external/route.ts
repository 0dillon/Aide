import {
  getApplications,
  getExternalApplications,
  getExternalJobs,
  getJob,
  getWorker,
  setExternalJobs,
  trackExternalJob,
} from "@/lib/store";
import { searchExternalJobs } from "@/lib/external";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ jobs: getExternalJobs(), applications: getExternalApplications() });
}

// { action: "scan" }        → search the web for listings matching the worker's skills
// { action: "track", id }   → record that the worker applied to a listing
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };

  if (body.action === "scan") {
    const w = getWorker();
    const verifiedSkills = getApplications()
      .filter((a) => a.verified)
      .map((a) => getJob(a.jobId)?.skill)
      .filter((s): s is string => !!s);
    const skills = [...new Set([...(w.skills ?? []), ...verifiedSkills])];
    const jobs = await searchExternalJobs(skills);
    setExternalJobs(jobs);
    return Response.json({ ok: true, jobs, matchedSkills: skills });
  }

  if (body.action === "track" && body.id) {
    const app = trackExternalJob(body.id);
    if (!app) return Response.json({ error: "No external listing with that id." }, { status: 400 });
    return Response.json({ ok: true, application: app });
  }

  return Response.json({ error: "action must be 'scan' or 'track' (with id)." }, { status: 400 });
}
