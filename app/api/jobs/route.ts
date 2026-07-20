import { listJobs, getApplications, getJob, getAccount, getWorker, publicJob } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Role-aware jobs data. Workers see every listing (with who posted it) plus
// their own applications; employers see only the jobs they posted, with the
// state of applications on them.
export async function GET(req: Request) {
  const acc = getAccount(userIdFrom(req));
  const w = getWorker();
  const applications = getApplications().map((a) => {
    const originalJob = getJob(a.jobId);
    const sanitizedJob = originalJob ? publicJob(originalJob) : undefined;
    return {
      ...a,
      workerName: w.name,
      workerSkills: w.skills ?? [],
      workerBio: w.bio ?? "",
      job: sanitizedJob
    };
  });

  if (acc.role === "employer") {
    const jobs = listJobs().filter((j) => j.employer.toLowerCase() === acc.name.toLowerCase());
    return Response.json({
      role: "employer",
      employerName: acc.name,
      jobs,
      applications: applications.filter((a) => jobs.some((j) => j.id === a.jobId)),
    });
  }

  return Response.json({ role: "worker", jobs: listJobs().map(publicJob), applications });
}
