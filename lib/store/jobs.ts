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
