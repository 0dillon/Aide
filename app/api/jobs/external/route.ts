import {
  getAccount,
  getApplications,
  getExternalApplications,
  getExternalJobs,
  getJob,
  setExternalJobs,
  trackExternalJob,
} from "@/lib/store";
import { searchExternalJobs } from "@/lib/external";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// External listings belong to the account that scanned for them. This used to
// resolve to the demo worker no matter who was signed in, so one person's web
// scan results — and the listings they were tracking — were everybody's.
export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const [jobs, applications] = await Promise.all([getExternalJobs(acc.id), getExternalApplications(acc.id)]);
  return Response.json({ jobs, applications });
}

// { action: "scan" }        → search the web for listings matching the worker's skills
// { action: "track", id }   → record that the worker applied to a listing
export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };

  if (body.action === "scan") {
    const w = acc;
    const apps = (await getApplications(w.id)).filter((a) => a.verified);
    const verifiedSkills = (await Promise.all(apps.map(async (a) => (await getJob(a.jobId))?.skill))).filter(
      (s): s is string => !!s,
    );
    const skills = [...new Set([...(w.skills ?? []), ...verifiedSkills])];
    const jobs = await searchExternalJobs(skills);
    await setExternalJobs(acc.id, jobs);
    return Response.json({ ok: true, jobs, matchedSkills: skills });
  }

  if (body.action === "track" && body.id) {
    const app = await trackExternalJob(acc.id, body.id);
    if (!app) return Response.json({ error: "No external listing with that id." }, { status: 400 });
    return Response.json({ ok: true, application: app });
  }

  return Response.json({ error: "action must be 'scan' or 'track' (with id)." }, { status: 400 });
}
