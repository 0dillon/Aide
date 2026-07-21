import { getAccount, getJob, listMessages, messagingUnlocked, sendMessage } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

const MAX_LEN = 2000;

// The onboarding channel that opens once a worker is hired for a gig. Both the
// employer who posted the gig and the (single, demo) worker may read and post;
// the reactive live delivery is handled by Convex + the events feed, so this
// route is just the gated read/write surface for the on-screen thread.

// Is this account a party to the gig's conversation?
function partyTo(job: { employer: string }, acc: { role: string; name: string }): "employer" | "worker" | null {
  if (acc.role === "employer") return job.employer.toLowerCase() === acc.name.toLowerCase() ? "employer" : null;
  if (acc.role === "worker") return "worker";
  return null;
}

export async function GET(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) return Response.json({ error: "jobId is required." }, { status: 400 });

  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "No job with that id." }, { status: 404 });
  if (!partyTo(job, acc)) return Response.json({ error: "That conversation is not yours." }, { status: 403 });

  const unlocked = await messagingUnlocked(jobId);
  return Response.json({
    role: acc.role,
    unlocked,
    jobTitle: job.title,
    messages: unlocked ? await listMessages(jobId) : [],
  });
}

export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  const { jobId, text } = (await req.json().catch(() => ({}))) as { jobId?: string; text?: string };
  if (!jobId || !text?.trim()) return Response.json({ error: "A job and a message are required." }, { status: 400 });
  if (text.length > MAX_LEN) return Response.json({ error: "That message is too long." }, { status: 400 });

  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "No job with that id." }, { status: 404 });

  const from = partyTo(job, acc);
  if (!from) return Response.json({ error: "That conversation is not yours." }, { status: 403 });

  if (!(await messagingUnlocked(jobId))) {
    return Response.json({ error: "Messaging opens once the worker is hired for this gig." }, { status: 409 });
  }

  const message = await sendMessage(jobId, from, acc.name, text);
  return Response.json({ ok: true, message });
}
