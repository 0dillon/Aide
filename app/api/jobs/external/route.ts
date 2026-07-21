import {
  getAccount,
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

// External listings belong to the worker who scanned for them — the same
// account that owns the applications.
const ownerId = () => getWorker().id;

export async function GET() {
  const [jobs, applications] = await Promise.all([getExternalJobs(ownerId()), getExternalApplications(ownerId())]);
  return Response.json({ jobs, applications });
}

// { action: "scan" }        → search the web for listings matching the worker's skills
// { action: "track", id }   → record that the worker applied to a listing
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };

  if (body.action === "scan") {
    const w = await getAccount(getWorker().id);
    const apps = (await getApplications()).filter((a) => a.verified);
    const verifiedSkills = (await Promise.all(apps.map(async (a) => (await getJob(a.jobId))?.skill))).filter(
      (s): s is string => !!s,
    );
    const skills = [...new Set([...(w.skills ?? []), ...verifiedSkills])];
    const jobs = await searchExternalJobs(skills);
    await setExternalJobs(ownerId(), jobs);
    return Response.json({ ok: true, jobs, matchedSkills: skills });
  }

  if (body.action === "track" && body.id) {
    const app = await trackExternalJob(ownerId(), body.id);
    if (!app) return Response.json({ error: "No external listing with that id." }, { status: 400 });
    return Response.json({ ok: true, application: app });
  }

  return Response.json({ error: "action must be 'scan' or 'track' (with id)." }, { status: 400 });
}
