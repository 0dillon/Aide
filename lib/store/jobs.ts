import { JOBS, newId, state, type ExternalApplication, type ExternalJob, type Job, type McqQuestion } from "./state";

// Post a new gig (employer flow — via the modal form or Aide's post_gig tool).
export function postJob(input: {
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
}): Job {
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
  JOBS.push(job);
  return job;
}

export function listJobs(skill?: string): Job[] {
  if (!skill) return JOBS;
  const q = skill.toLowerCase();
  return JOBS.filter((j) => j.skill.includes(q) || j.title.toLowerCase().includes(q));
}

export function getJob(id: string): Job | undefined {
  return JOBS.find((j) => j.id === id);
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

export function setExternalJobs(jobs: ExternalJob[]): void {
  state.externalJobs = jobs;
}

export function getExternalJobs(): ExternalJob[] {
  return state.externalJobs!;
}

export function getExternalApplications(): ExternalApplication[] {
  return [...state.externalApps!].sort((a, b) => b.at - a.at);
}

// Record that the worker applied to an external listing so Aide can track it.
export function trackExternalJob(externalJobId: string): ExternalApplication | undefined {
  const job = state.externalJobs!.find((j) => j.id === externalJobId);
  if (!job) return undefined;
  const existing = state.externalApps!.find((a) => a.externalJobId === externalJobId);
  if (existing) return existing;
  const app: ExternalApplication = {
    id: newId(),
    externalJobId,
    title: job.title,
    company: job.company,
    url: job.url,
    status: "tracked",
    at: Date.now(),
  };
  state.externalApps!.push(app);
  return app;
}
