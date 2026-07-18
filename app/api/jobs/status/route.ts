import { getAccount, hireWorker, payWorker } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const acc = getAccount(userIdFrom(req));
  if (acc.role !== "employer") {
    return Response.json({ error: "Only employers can modify application status." }, { status: 403 });
  }

  const { jobId, action } = (await req.json().catch(() => ({}))) as { jobId?: string; action?: "hire" | "pay" };
  if (!jobId || !action) {
    return Response.json({ error: "jobId and action are required." }, { status: 400 });
  }

  let app;
  if (action === "hire") {
    app = hireWorker(jobId);
  } else if (action === "pay") {
    app = payWorker(jobId);
  }

  if (!app) {
    return Response.json({ error: "Application not found." }, { status: 404 });
  }

  return Response.json({ ok: true, application: app });
}
