import { getAccount, getJob, getWorker, hireWorker, payWorker, publishEvent, rejectWorker, verifyPaymentCoverage } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const acc = await getAccount(userIdFrom(req));
  if (acc.role !== "employer") {
    return Response.json({ error: "Only employers can modify application status." }, { status: 403 });
  }

  const { jobId, action } = (await req.json().catch(() => ({}))) as { jobId?: string; action?: "hire" | "reject" | "pay" };
  if (!jobId || !action) {
    return Response.json({ error: "jobId and action are required." }, { status: 400 });
  }

  const job = await getJob(jobId);
  if (!job || job.employer.toLowerCase() !== acc.name.toLowerCase()) {
    return Response.json({ error: "That gig is not one of your postings." }, { status: 403 });
  }

  let app;
  if (action === "hire") {
    app = await hireWorker(jobId);
    if (app) {
      // Aide tells the worker out loud, the moment the decision is made.
      publishEvent(getWorker().id, {
        type: "notify",
        message: `Great news from ${job.employer}: you have been hired for ${job.title}. Say "help me with my job" and I will guide you through the task.`,
      });
    }
  } else if (action === "reject") {
    app = await rejectWorker(jobId);
    if (app) {
      publishEvent(getWorker().id, {
        type: "notify",
        message: `An update on ${job.title} from ${job.employer}: they went with another applicant this time. Your assessment result stays on your profile — I can find you more jobs whenever you're ready.`,
      });
    }
  } else if (action === "pay") {
    // "Paid" must mean paid: only allowed when a confirmed Monnify inbound
    // payment actually covers this gig.
    const coverage = await verifyPaymentCoverage(jobId);
    if (!coverage.ok) return Response.json({ error: coverage.message }, { status: 409 });
    app = await payWorker(jobId);
  }

  if (!app) {
    return Response.json({ error: "Application not found." }, { status: 404 });
  }

  return Response.json({ ok: true, application: app });
}
