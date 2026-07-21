import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { worker } from "./state";
import { getApplication } from "./applications";
import { getJob } from "./jobs";
import { listAccounts } from "./accounts";
import { publishEvent } from "./events";

// The post-hire onboarding channel, server side. The channel is deliberately
// gated: it only opens once the employer has hired the applicant, so it can
// never be used as a pre-hire back-channel that would sidestep the assessment.
// Both the Next API route and Aide's voice tools go through here, so the gate
// and the "read it aloud to the other party" notification live in one place.

export type MessageFrom = "worker" | "employer";
export type Message = { id: string; jobId: string; from: MessageFrom; authorName: string; text: string; at: number };

type MsgDoc = {
  _id: string;
  jobId: string;
  workerAccountId: string;
  from: MessageFrom;
  authorName: string;
  text: string;
  at: number;
};

function toMessage(d: MsgDoc): Message {
  return { id: d._id, jobId: d.jobId, from: d.from, authorName: d.authorName, text: d.text, at: d.at };
}

// Messaging unlocks the moment the applicant is hired, and stays open through
// payment so onboarding and follow-up can continue after the money moves.
export async function messagingUnlocked(jobId: string): Promise<boolean> {
  const app = await getApplication(jobId);
  return !!app && (app.status === "hired" || app.status === "paid");
}

export async function listMessages(jobId: string): Promise<Message[]> {
  const docs = (await convexClient().query(api.messages.listForJob, { jobId })) as MsgDoc[];
  return docs.map(toMessage);
}

// Append a message and announce it to the OTHER party's reactive event feed —
// the accessible equivalent of a notification: their Aide speaks it aloud the
// moment it lands. Callers must have already checked messagingUnlocked and that
// the sender is a party to the gig.
export async function sendMessage(jobId: string, from: MessageFrom, authorName: string, text: string): Promise<Message> {
  const clean = text.trim();
  const d = (await convexClient().mutation(api.messages.send, {
    jobId,
    workerAccountId: worker.id,
    from,
    authorName,
    text: clean,
  })) as MsgDoc;

  const job = await getJob(jobId);
  if (job) {
    if (from === "employer") {
      publishEvent(worker.id, {
        type: "notify",
        message: `New onboarding message from ${job.employer} about ${job.title}. They said: ${clean}`,
      });
    } else {
      // Notify the employer's own account, found by the name on the gig.
      const employer = (await listAccounts()).find(
        (a) => a.role === "employer" && a.name.toLowerCase() === job.employer.toLowerCase(),
      );
      if (employer) {
        publishEvent(employer.id, {
          type: "notify",
          message: `New message from your hired worker about ${job.title}. They said: ${clean}`,
        });
      }
    }
  }

  return toMessage(d);
}
