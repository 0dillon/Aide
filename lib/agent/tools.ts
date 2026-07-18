import { tool } from "ai";
import { z } from "zod";
import * as store from "../store";
import { registerPayout, confirmWithdrawal } from "../payments";
import type { Account } from "../store";

// Aide's tools, built per-request around the signed-in account so the model
// acts as the right person (worker vs employer). Every money fact comes from
// a real server call — the model never decides financial truth, it only
// narrates what a tool returns.
export function makeTools(account: Account) {
  return {
    open_page: tool({
      description:
        "Open one of Aide's screens for the user: 'home' (talking to Aide), 'jobs' (job listings and spoken assessments; for employers, their posted gigs), 'payments' (balance, receiving money, withdrawals), 'profile' (their account, completed jobs, verified skills), or 'signup' (create an account). Use when the user asks to go to, open, or see one of these screens. A small version of you follows them there, so keep talking naturally.",
      parameters: z.object({ page: z.enum(["home", "jobs", "payments", "profile", "signup"]) }),
      execute: async ({ page }) => ({ ok: true, page }),
    }),

    create_account: tool({
      description:
        "Create the user's account by voice. Ask for their name and whether they want to join as a worker (find and do gigs) or an employer (post work and pay workers), confirm both back to them, then call this. The browser is signed in automatically.",
      parameters: z.object({
        name: z.string().describe("the user's name, as they said it"),
        role: z.enum(["worker", "employer"]),
      }),
      execute: async ({ name, role }) => {
        const acc = store.createAccount(name, role);
        return { ok: true, userId: acc.id, name: acc.name, role: acc.role };
      },
    }),

    post_gig: tool({
      description:
        "Post a new gig for the employer, fully by voice. Collect the gig title or type, the skill it needs, the pay in Naira, whether it requires a spoken assessment, and if so the exact assessment question to ask applicants. Read all the details back and get a spoken yes before calling. Only works for employer accounts.",
      parameters: z.object({
        title: z.string().describe("gig title, e.g. 'Transcribe a 20 minute podcast'"),
        skill: z.string().describe("the skill or gig type, e.g. transcription"),
        pay: z.number().describe("pay in Naira"),
        requiresAssessment: z.boolean(),
        assessmentQuestion: z.string().optional().describe("the spoken question applicants must answer, if an assessment is required"),
      }),
      execute: async ({ title, skill, pay, requiresAssessment, assessmentQuestion }) => {
        if (account.role !== "employer") {
          return { ok: false, message: "Only employer accounts can post gigs. Offer to create an employer account first." };
        }
        if (!Number.isFinite(pay) || pay <= 0) return { ok: false, message: "Pay must be a positive amount in Naira." };
        const job = store.postJob({ title, skill, pay, employer: account.name, requiresAssessment, assessmentQuestion });
        return { ok: true, jobId: job.id, title: job.title, pay: job.pay, requiresAssessment: job.requiresAssessment };
      },
    }),

    list_jobs: tool({
      description:
        "List available jobs the worker can do, optionally filtered by a skill or keyword the user mentioned (e.g. transcription, translation, phone support).",
      parameters: z.object({ skill: z.string().optional().describe("skill or keyword to filter by") }),
      execute: async ({ skill }) =>
        store.listJobs(skill).map((j) => ({ id: j.id, title: j.title, pay: j.pay, skill: j.skill, employer: j.employer })),
    }),

    apply_to_job: tool({
      description: "Apply the worker to a job by its id. Confirm with the user first.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        const job = store.getJob(jobId);
        if (!job) return { ok: false, message: "No job with that id." };
        const app = store.apply(jobId);
        return { ok: true, applicationId: app.id, title: job.title, needsAssessment: job.requiresAssessment };
      },
    }),

    get_applications: tool({
      description: "List the worker's current job applications and their status.",
      parameters: z.object({}),
      execute: async () => store.getApplications().map((a) => ({ ...a, job: store.getJob(a.jobId)?.title })),
    }),

    start_assessment: tool({
      description: "Start the assessment for a job. Returns the assessment type ('oral' or 'mcq'), oral prompt or MCQ questions, the time limit in seconds (if any), and start timestamp. You should announce the assessment details, including the time limit, to the user.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        const job = store.getJob(jobId);
        if (!job) return { ok: false, message: "No job with that id." };
        const startTime = store.recordAttempt(account.id, jobId);
        const type = job.assessmentType || "oral";
        if (type === "mcq") {
          const sanitizedQuestions = job.mcqQuestions?.map(({ question, options }) => ({ question, options })) || [];
          return {
            ok: true,
            assessmentType: "mcq",
            questions: sanitizedQuestions,
            timeLimit: job.timeLimit,
            startedAt: startTime,
          };
        } else {
          return {
            ok: true,
            assessmentType: "oral",
            prompt: store.assessmentPromptFor(job),
            timeLimit: job.timeLimit,
            startedAt: startTime,
          };
        }
      },
    }),

    assessment_time_left: tool({
      description:
        "How much time is left on the user's running, time-limited assessment. Call this when they ask how much time they have; report the remaining time honestly, then return to the current question.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        const t = store.timeRemaining(account.id, jobId);
        if (!t) return { ok: false, message: "This assessment has no time limit, or it hasn't been started." };
        return { ok: true, remainingSeconds: t.remaining, limitSeconds: t.limit };
      },
    }),

    submit_assessment: tool({
      description: "Submit the worker's answer(s) to the assessment. For oral assessments, pass 'answer' as the spoken text. For MCQ assessments, pass 'answers' as an array of 0-based option indices corresponding to the user's choice for each question.",
      parameters: z.object({
        jobId: z.string(),
        answer: z.string().optional().describe("the worker's spoken answer (for oral assessments)"),
        answers: z.array(z.number()).optional().describe("the chosen option indices, 0-based (for MCQ assessments)"),
      }),
      execute: async ({ jobId, answer, answers }) => {
        if (answers !== undefined) {
          return { ok: true, ...store.gradeMcqAssessment(account.id, jobId, answers) };
        }
        if (answer !== undefined) {
          return { ok: true, ...store.gradeOralAssessment(account.id, jobId, answer) };
        }
        return { ok: false, message: "Either 'answer' or 'answers' must be provided." };
      },
    }),

    get_balance: tool({
      description: "Get the worker's confirmed balance (real, from Monnify) in Naira.",
      parameters: z.object({}),
      execute: async () => {
        const { balance, account: acctNo } = await store.getBalance();
        return { balance, currency: "NGN", account: acctNo };
      },
    }),

    register_payout_account: tool({
      description:
        "Validate and save the worker's bank account for withdrawals. Read the returned account name back to the user for spoken confirmation before withdrawing.",
      parameters: z.object({ accountNumber: z.string(), bankCode: z.string().describe("3-digit NIP bank code, e.g. 035 Wema, 058 GTBank") }),
      execute: async ({ accountNumber, bankCode }) => registerPayout(accountNumber, bankCode),
    }),

    prepare_withdrawal: tool({
      description:
        "Step 1 of 2 for a withdrawal. Arms a withdrawal of `amount` Naira to the saved payout account and returns a one-word confirmation phrase. Do NOT move money here. After calling, read the amount and account NAME back to the user, then tell them to say the returned `phrase` word aloud to confirm.",
      parameters: z.object({ amount: z.number().describe("amount in Naira to withdraw") }),
      execute: async ({ amount }) => store.armWithdrawal(amount),
    }),

    confirm_withdrawal: tool({
      description:
        "Step 2 of 2 for a withdrawal. Pass exactly what the user said when asked to confirm. Only call this after the user has spoken; never invent the phrase. If it matches the armed confirmation word, the real bank transfer runs and the status is returned.",
      parameters: z.object({ spokenPhrase: z.string().describe("the exact words the user just spoke to confirm") }),
      execute: async ({ spokenPhrase }) => confirmWithdrawal(spokenPhrase),
    }),

    update_profile: tool({
      description:
        "Update the worker's profile by voice. You can update their name, email, skills (an array of self-declared skills), or bio (their experience/resume summary). Speak back the updated details to confirm.",
      parameters: z.object({
        name: z.string().optional().describe("the worker's updated full name"),
        email: z.string().optional().describe("the worker's updated email"),
        skills: z.array(z.string()).optional().describe("updated list of self-declared skills"),
        bio: z.string().optional().describe("updated resume/bio description"),
      }),
      execute: async (input) => {
        const result = store.updateProfile(account.id, input);
        return { ok: true, name: result.worker.name, skills: result.worker.skills, bio: result.worker.bio };
      },
    }),
  };
}
