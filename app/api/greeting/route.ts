import { getAccount, getApplications, getBalance, getJob, getWallet, listJobs } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

// Aide's opening line when the platform spins up, built server-side from real
// state so it always reflects the truth, never the model's imagination. What
// it says depends on who is signed in: workers hear about money and pending
// assessments, employers hear about their gigs and applicants.
export async function GET(req: Request) {
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const acc = await getAccount(userIdFrom(req));

  if (acc.role === "employer") {
    const posted = (await listJobs()).filter((j) => j.employer.toLowerCase() === acc.name.toLowerCase());
    const apps = (await getApplications()).filter((a) => posted.some((j) => j.id === a.jobId));
    const readyToHire = apps.filter((a) => a.status === "assessed");
    const parts = [`${hello} ${acc.name}, I'm Aide. I'm listening — just talk to me.`];
    parts.push(
      posted.length === 0
        ? "You haven't posted any gigs yet — say post a new gig and I'll set one up with you."
        : `You have ${posted.length} gig${posted.length === 1 ? "" : "s"} posted.`,
    );
    if (readyToHire.length > 0) {
      parts.push(
        `${readyToHire.length} applicant${readyToHire.length === 1 ? " has" : "s have"} passed their spoken assessment and ${readyToHire.length === 1 ? "is" : "are"} ready to hire.`,
      );
    }
    parts.push("What would you like to do?");
    return Response.json({ greeting: parts.join(" ") });
  }

  const parts: string[] = [`${hello}, I'm Aide, your work and pay assistant. I'm listening — just talk to me.`];

  // Never let Monnify delay Aide's first words: if the balance isn't back in
  // 2.5s, greet without the money line (usually served from cache anyway).
  // This also lazily provisions the user's own wallet on their first visit.
  let balance: number | null = null;
  try {
    balance = await Promise.race<number | null>([
      getBalance(acc.id).then((b) => b.balance),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
  } catch {
    /* greet without the money line */
  }

  const apps = await getApplications();
  const pendingChecks = await Promise.all(
    apps.map(async (a) => a.status === "applied" && !a.verified && !!(await getJob(a.jobId))?.requiresAssessment),
  );
  const awaitingAssessment = apps.filter((_, i) => pendingChecks[i]);

  const wallet = await getWallet(acc.id);
  if (wallet.pendingWithdrawal) {
    parts.push(`You have a withdrawal of ${wallet.pendingWithdrawal.amount} naira waiting for your spoken confirmation.`);
  }
  if (balance !== null && balance > 0) {
    parts.push(`You have ${balance} naira in your account, ready to withdraw.`);
  }
  if (awaitingAssessment.length > 0) {
    parts.push(
      awaitingAssessment.length === 1
        ? `One of your job applications is waiting for a short spoken assessment — say start my assessment when you're ready.`
        : `${awaitingAssessment.length} of your job applications are waiting for short spoken assessments — say start my assessment when you're ready.`,
    );
  } else if (acc.skills.length === 0 && !acc.bio) {
    // Voice-native onboarding: a worker with an empty profile is offered a
    // spoken setup. Their "yes" goes to the agent, which collects skills and
    // bio conversationally (see the onboarding rules in the system prompt).
    parts.push(
      "Your profile is still empty. Would you like to set it up now? I can write down your skills and a short bio just from talking with you, and use them to match you with the right jobs. Just say yes and we'll do it together.",
    );
  } else if (apps.length === 0) {
    parts.push(`There are ${(await listJobs()).length} jobs available right now — ask me to find you work.`);
  }
  parts.push("What would you like to do?");

  return Response.json({ greeting: parts.join(" ") });
}
