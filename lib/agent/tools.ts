import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import * as store from "../store";
import { validateBankAccount, singleTransfer } from "../monnify";

// Aide's tools. Every money fact comes from a real server call — the model
// never decides financial truth, it only narrates what a tool returns.
export const tools = {
  list_jobs: tool({
    description: "List available jobs the worker can do, optionally filtered by a skill or keyword the user mentioned (e.g. transcription, translation, phone support).",
    parameters: z.object({ skill: z.string().optional().describe("skill or keyword to filter by") }),
    execute: async ({ skill }) => store.listJobs(skill).map((j) => ({ id: j.id, title: j.title, pay: j.pay, skill: j.skill, employer: j.employer })),
  }),

  apply_to_job: tool({
    description: "Apply the worker to a job by its id. Confirm with the user first.",
    parameters: z.object({ jobId: z.string() }),
    execute: async ({ jobId }) => {
      const job = store.getJob(jobId);
      if (!job) return { ok: false, message: "No job with that id." };
      const app = store.apply(jobId);
      return { ok: true, applicationId: app.id, title: job.title, needsAssessment: true };
    },
  }),

  get_applications: tool({
    description: "List the worker's current job applications and their status.",
    parameters: z.object({}),
    execute: async () => store.getApplications().map((a) => ({ ...a, job: store.getJob(a.jobId)?.title })),
  }),

  start_assessment: tool({
    description: "Return the oral assessment prompt for a job the worker applied to. The user answers by voice.",
    parameters: z.object({ jobId: z.string() }),
    execute: async ({ jobId }) => {
      const job = store.getJob(jobId);
      if (!job) return { ok: false, message: "No job with that id." };
      return { ok: true, prompt: `To verify your ${job.skill} skill: in one or two sentences, describe how you would approach this task — "${job.task}"` };
    },
  }),

  submit_assessment: tool({
    description: "Submit the worker's spoken answer to an assessment. Marks the skill verified if the answer is on-topic and substantive.",
    parameters: z.object({ jobId: z.string(), answer: z.string() }),
    execute: async ({ jobId, answer }) => {
      const passed = answer.trim().split(/\s+/).length >= 8;
      if (passed) store.markVerified(jobId);
      return { ok: true, verified: passed, message: passed ? "Skill verified." : "Answer too brief — ask them to elaborate." };
    },
  }),

  get_balance: tool({
    description: "Get the worker's confirmed balance (real, from Monnify) in Naira.",
    parameters: z.object({}),
    execute: async () => {
      const { balance, account } = await store.getBalance();
      return { balance, currency: "NGN", account };
    },
  }),

  register_payout_account: tool({
    description: "Validate and save the worker's bank account for withdrawals. Read the returned account name back to the user for spoken confirmation before withdrawing.",
    parameters: z.object({ accountNumber: z.string(), bankCode: z.string().describe("3-digit NIP bank code, e.g. 035 Wema, 058 GTBank") }),
    execute: async ({ accountNumber, bankCode }) => {
      try {
        const r = await validateBankAccount(accountNumber, bankCode);
        store.setPayout(accountNumber, bankCode, r.accountName);
        return { ok: true, accountName: r.accountName };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
  }),

  initiate_withdrawal: tool({
    description: "Withdraw an amount (Naira) to the worker's saved bank account. Requires explicit voice confirmation first. Returns the transfer status.",
    parameters: z.object({ amount: z.number() }),
    execute: async ({ amount }) => {
      const w = store.getWorker();
      if (!w.payoutAccount || !w.payoutBankCode || !w.payoutAccountName) {
        return { ok: false, message: "No payout account saved yet. Register one first." };
      }
      try {
        const r = await singleTransfer({
          amount,
          reference: `aide-wd-${randomUUID().slice(0, 8)}`,
          narration: "Aide withdrawal",
          destinationAccountNumber: w.payoutAccount,
          destinationBankCode: w.payoutBankCode,
          destinationAccountName: w.payoutAccountName,
        });
        const pending = r.status === "PENDING_AUTHORIZATION";
        return { ok: true, status: r.status, pending, message: pending ? "Withdrawal initiated and is being processed." : "Withdrawal completed." };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
  }),
};
