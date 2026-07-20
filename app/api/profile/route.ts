import { getAccount, getApplications, getBalance, getJob, listJobs, publicAccount, updateProfile } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Role-aware profile. "Completed jobs" means different things per role:
// a worker completes gigs (verified assessments); an employer has gigs
// completed FOR them on jobs they posted.
export async function GET(req: Request) {
  const acc = getAccount(userIdFrom(req));

  if (acc.role === "employer") {
    const posted = listJobs().filter((j) => j.employer.toLowerCase() === acc.name.toLowerCase());
    const apps = getApplications();
    const completed = posted.filter((j) => apps.some((a) => a.jobId === j.id && a.verified));
    return Response.json({
      account: publicAccount(acc),
      role: "employer",
      jobsPosted: posted,
      jobsCompleted: completed.map((j) => j.id),
      totalCommitted: posted.reduce((s, j) => s + j.pay, 0),
    });
  }

  // Worker profile — balance is best-effort so the page still renders when
  // Monnify is unreachable.
  let balance: number | null = null;
  let wallet: { account?: string; bankName?: string } = {};
  try {
    const b = await getBalance(acc.id);
    balance = b.balance;
    wallet = b;
  } catch {}
  const applications = getApplications().map((a) => ({ ...a, job: getJob(a.jobId) }));
  const verified = applications.filter((a) => a.verified);
  return Response.json({
    account: publicAccount(acc),
    role: "worker",
    applications,
    completedJobs: verified.length,
    verifiedSkills: [...new Set(verified.map((a) => a.job?.skill).filter(Boolean))],
    skills: acc.skills,
    bio: acc.bio,
    balance,
    accountNumber: wallet.account,
    bankName: wallet.bankName,
  });
}

// Update profile details (Worker name, email, skills, bio)
export async function POST(req: Request) {
  const userId = userIdFrom(req) || "demo-worker";
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    email?: string;
    skills?: string[];
    bio?: string;
  };
  const result = updateProfile(userId, body);
  return Response.json({ ok: true, ...result });
}
