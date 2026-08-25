import { listJobs, getApplications, getJob, getAccount, listApplicantsForJobs, ownsJob, publicJob } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Role-aware jobs data. Workers see every listing (with who posted it) plus
// their OWN applications; employers see only the gigs they posted, with the
// real applicants on them.
//
// Both halves used to read one hardcoded worker: every signed-in worker was
// shown the demo worker's applications as their own, and every employer saw
// that same worker's name and bio attached to whatever had been applied for.
export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req));

  // Applicant display data comes from each applicant's Convex account, not an
  // in-memory copy, so an employer on another instance sees current details.
  const decorate = async (apps: { jobId: string; accountId?: string }[], fallbackAccountId: string) =>
    await Promise.all(
      apps.map(async (a) => {
        const applicant = await getAccount(a.accountId ?? fallbackAccountId);
        const originalJob = await getJob(a.jobId);
        return {
          ...a,
          workerName: applicant.name,
          workerSkills: applicant.skills ?? [],
          workerBio: applicant.bio ?? "",
          job: originalJob ? publicJob(originalJob) : undefined,
        };
      }),
    );

  if (acc.role === "employer") {
    const jobs = (await listJobs()).filter((j) => ownsJob(acc, j));
    const applicants = await listApplicantsForJobs(jobs.map((j) => j.id));
    return Response.json({
      role: "employer",
      employerName: acc.name,
      jobs,
      applications: await decorate(applicants, acc.id),
    });
  }

  return Response.json({
    role: "worker",
    jobs: (await listJobs()).map(publicJob),
    applications: await decorate(await getApplications(acc.id), acc.id),
  });
}
