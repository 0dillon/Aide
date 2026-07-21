import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { JOBS, newId, type ExternalApplication, type ExternalJob, type Job, type McqQuestion } from "./state";

// Jobs come from two places: the four seeded demo gigs (static, in code — they
// never change) and gigs employers post at runtime, which live in Convex so
// they're visible across serverless instances instead of only on whichever
// instance happened to handle the POST.

type PostedJobDoc = Omit<Job, "id"> & { jobId: string; at: number };

function toJob(d: PostedJobDoc): Job {
  return {
    id: d.jobId,
    title: d.title,
    task: d.task,
    skill: d.skill,
    pay: d.pay,
    employer: d.employer,
    requiresAssessment: d.requiresAssessment,
    assessmentType: d.assessmentType,
    assessmentQuestion: d.assessmentQuestion,
    mcqQuestions: d.mcqQuestions,
    timeLimit: d.timeLimit,
  };
}

async function postedJobs(): Promise<Job[]> {
  try {
    const docs = (await convexClient().query(api.jobs.listPosted, {})) as PostedJobDoc[];
    return docs.map(toJob);
  } catch {
    return []; // Convex unreachable — still show the seeded gigs
  }
}

// Validated, normalized gig ready for postJob (minus employer, added by the
// caller). The one place gig rules live, so the manual post route and Aide's
// post_gig voice tool accept exactly the same gigs.
export type ValidatedGig = {
  title: string;
  skill: string;
  pay: number;
  requiresAssessment: boolean;
  assessmentType?: "oral" | "mcq";
  assessmentQuestion?: string;
  mcqQuestions?: McqQuestion[];
  timeLimit?: number; // seconds
  task?: string;
};

export function validateGig(input: {
  title?: string;
  skill?: string;
  pay?: number;
  requiresAssessment?: boolean;
  assessmentType?: "oral" | "mcq";
  assessmentQuestion?: string;
  mcqQuestions?: McqQuestion[];
  timeLimit?: number;
  task?: string;
}): { ok: true; gig: ValidatedGig } | { ok: false; message: string } {
  if (!input.title?.trim()) return { ok: false, message: "A gig title is required." };
  if (!input.skill?.trim()) return { ok: false, message: "A gig type or skill is required." };
  const pay = Number(input.pay);
  if (!Number.isFinite(pay) || pay <= 0) return { ok: false, message: "Pay must be a positive amount in Naira." };

  let timeLimit: number | undefined;
  if (input.timeLimit !== undefined) {
    timeLimit = Number(input.timeLimit);
    if (!Number.isInteger(timeLimit) || timeLimit <= 0 || timeLimit > 3600) {
      return { ok: false, message: "Time limit must be a positive whole number of seconds up to 3600 (one hour)." };
    }
  }

  let mcqQuestions: McqQuestion[] | undefined;
  if (input.requiresAssessment && input.assessmentType === "mcq") {
    const qs = input.mcqQuestions;
    if (!Array.isArray(qs) || qs.length === 0) {
      return { ok: false, message: "At least one question is required for multiple choice assessments." };
    }
    if (qs.length > 10) return { ok: false, message: "A maximum of 10 questions is allowed." };
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (!q.question?.trim()) return { ok: false, message: `Question ${i + 1} has no text.` };
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) {
        return { ok: false, message: `Question ${i + 1} must have between 2 and 6 options.` };
      }
      for (let j = 0; j < q.options.length; j++) {
        if (!q.options[j]?.trim()) return { ok: false, message: `Question ${i + 1}, option ${j + 1} is empty.` };
      }
      const idx = Number(q.correctIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) {
        return { ok: false, message: `Question ${i + 1} must mark which option is correct.` };
      }
    }
    mcqQuestions = qs.map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      correctIndex: Number(q.correctIndex),
    }));
  }

  return {
    ok: true,
    gig: {
      title: input.title,
      skill: input.skill,
      pay,
      requiresAssessment: !!input.requiresAssessment,
      assessmentType: input.requiresAssessment ? input.assessmentType : undefined,
      assessmentQuestion: input.assessmentQuestion,
      mcqQuestions,
      timeLimit,
      task: input.task,
    },
  };
}

// Post a new gig (employer flow — via the modal form or Aide's post_gig tool).
export async function postJob(input: {
  title: string;
  skill: string;
  pay: number;
  employer: string;
  requiresAssessment: boolean;
  assessmentType?: "oral" | "mcq";
  assessmentQuestion?: string;
  mcqQuestions?: McqQuestion[];
  timeLimit?: number; // in seconds
  task?: string;
}): Promise<Job> {
  const job: Job = {
    id: `g-${newId(6)}`,
    title: input.title.trim(),
    task: input.task?.trim() || input.title.trim(),
    skill: input.skill.trim().toLowerCase(),
    pay: input.pay,
    employer: input.employer,
    requiresAssessment: input.requiresAssessment,
    assessmentType: input.requiresAssessment ? input.assessmentType || "oral" : undefined,
    assessmentQuestion: input.assessmentQuestion?.trim() || undefined,
    mcqQuestions: input.mcqQuestions,
    timeLimit: input.timeLimit,
  };
  await convexClient().mutation(api.jobs.post, {
    jobId: job.id,
    title: job.title,
    task: job.task,
    skill: job.skill,
    pay: job.pay,
    employer: job.employer,
    requiresAssessment: job.requiresAssessment,
    assessmentType: job.assessmentType,
    assessmentQuestion: job.assessmentQuestion,
    mcqQuestions: job.mcqQuestions,
    timeLimit: job.timeLimit,
  });
  return job;
}

export async function listJobs(skill?: string): Promise<Job[]> {
  const all = [...JOBS, ...(await postedJobs())];
  if (!skill) return all;
  const q = skill.toLowerCase();
  return all.filter((j) => j.skill.includes(q) || j.title.toLowerCase().includes(q));
}

export async function getJob(id: string): Promise<Job | undefined> {
  const seeded = JOBS.find((j) => j.id === id);
  if (seeded) return seeded;
  return (await postedJobs()).find((j) => j.id === id);
}

// The spoken-assessment question: the employer's own wording when they gave
// one, otherwise derived from the task.
export function assessmentPromptFor(job: Job): string {
  return (
    job.assessmentQuestion ||
    `To verify your ${job.skill} skill: in one or two sentences, describe how you would approach this task — "${job.task}"`
  );
}

// Strip correctIndex from MCQ questions so they are hidden from workers/agents
export function publicJob(job: Job): Omit<Job, "mcqQuestions"> & { mcqQuestions?: Omit<McqQuestion, "correctIndex">[] } {
  const { mcqQuestions, ...rest } = job;
  return {
    ...rest,
    mcqQuestions: mcqQuestions?.map(({ question, options }) => ({ question, options })),
  };
}

// --- External listings Aide found on the open web ---

type ExternalJobDoc = { extId: string; title: string; company: string; url: string; skill: string; source: string };
type ExternalAppDoc = Omit<ExternalApplication, "id"> & { _id: string };

export async function setExternalJobs(accountId: string, jobs: ExternalJob[]): Promise<void> {
  await convexClient().mutation(api.jobs.setExternalJobs, {
    accountId,
    jobs: jobs.map((j) => ({ extId: j.id, title: j.title, company: j.company, url: j.url, skill: j.skill, source: j.source })),
  });
}

export async function getExternalJobs(accountId: string): Promise<ExternalJob[]> {
  const docs = (await convexClient().query(api.jobs.listExternalJobs, { accountId })) as ExternalJobDoc[];
  return docs.map((d) => ({ id: d.extId, title: d.title, company: d.company, url: d.url, skill: d.skill, source: d.source }));
}

export async function getExternalApplications(accountId: string): Promise<ExternalApplication[]> {
  const docs = (await convexClient().query(api.jobs.listExternalApps, { accountId })) as ExternalAppDoc[];
  return docs.map((d) => ({
    id: d._id,
    externalJobId: d.externalJobId,
    title: d.title,
    company: d.company,
    url: d.url,
    status: "tracked",
    at: d.at,
  }));
}

// Record that the worker applied to an external listing so Aide can track it.
export async function trackExternalJob(accountId: string, externalJobId: string): Promise<ExternalApplication | undefined> {
  const d = (await convexClient().mutation(api.jobs.trackExternal, { accountId, externalJobId })) as
    | ExternalAppDoc
    | null;
  if (!d) return undefined;
  return { id: d._id, externalJobId: d.externalJobId, title: d.title, company: d.company, url: d.url, status: "tracked", at: d.at };
}
