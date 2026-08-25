import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { listApplicantsForJob } from "./applications";
import { getJob, ownsJob } from "./jobs";
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

// Who this gig's thread actually belongs to. The channel exists between ONE
// hired worker and the employer who hired them, so both ends are derived from
// the data rather than assumed.
//
// The old check asked only whether the reader had the role "worker", which
// made every worker on the platform a party to every thread — and the employer
// side compared display names, which two accounts can share. Since the system
// prompt tells employers to pass credentials through here, that was the worst
// place in the app to be approximate.
export type ThreadParties = { workerAccountId: string; hired: boolean };

export async function threadParties(jobId: string): Promise<ThreadParties | null> {
  const applicants = await listApplicantsForJob(jobId);
  const active = applicants.find((a) => a.status === "hired" || a.status === "paid") ?? applicants[0];
  if (!active) return null;
  return { workerAccountId: active.accountId, hired: active.status === "hired" || active.status === "paid" };
}

// Which side of this conversation the account is on, or null for everyone else.
export async function partyToThread(
  acc: { id: string; name: string; role: string },
  jobId: string,
): Promise<MessageFrom | null> {
  const job = await getJob(jobId);
  if (!job) return null;
  if (acc.role === "employer") return ownsJob(acc, job) ? "employer" : null;
  const parties = await threadParties(jobId);
  return parties && parties.workerAccountId === acc.id ? "worker" : null;
}

// Messaging unlocks the moment the applicant is hired, and stays open through
// payment so onboarding and follow-up can continue after the money moves.
export async function messagingUnlocked(jobId: string): Promise<boolean> {
  const parties = await threadParties(jobId);
  return !!parties?.hired;
}

export async function listMessages(jobId: string): Promise<Message[]> {
  const docs = (await convexClient().query(api.messages.listForJob, { jobId })) as MsgDoc[];
  return docs.map(toMessage);
}

// Append a message and announce it to the OTHER party's reactive event feed —
// the accessible equivalent of a notification: their Aide speaks it aloud the
// moment it lands. Callers must have already checked messagingUnlocked and that
// the sender is a party to the gig.
export async function sendMessage(
  jobId: string,
  from: MessageFrom,
  authorAccountId: string,
  authorName: string,
  text: string,
): Promise<Message> {
  const clean = text.trim();
  const parties = await threadParties(jobId);
  const d = (await convexClient().mutation(api.messages.send, {
    jobId,
    // The thread belongs to the hired applicant, not to a fixed demo worker.
    workerAccountId: parties?.workerAccountId ?? authorAccountId,
    from,
    authorAccountId,
    authorName,
    text: clean,
  })) as MsgDoc;

  const job = await getJob(jobId);
  if (job) {
    if (from === "employer" && parties) {
      publishEvent(parties.workerAccountId, {
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

// Delete a message you wrote. Ownership is checked inside the Convex mutation
// against the stored author id, so a caller cannot claim someone else's.
export async function deleteMessage(accountId: string, messageId: string): Promise<{ ok: boolean; message: string }> {
  const r = (await convexClient().mutation(api.messages.remove, {
    messageId: messageId as never,
    accountId,
  })) as { ok: true; jobId: string } | { ok: false; reason: "missing" | "not-yours" };
  if (r.ok) return { ok: true, message: "Message deleted." };
  if (r.reason === "missing") return { ok: false, message: "That message no longer exists." };
  return { ok: false, message: "You can only delete messages you sent yourself." };
}
