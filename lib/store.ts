import { randomUUID } from "node:crypto";
import { createReservedAccount, getReservedAccountTransactions } from "./monnify";

// In-memory demo state. One seeded worker. Real Monnify reserved account +
// real balance from confirmed inbound payments. Swap for Convex/Postgres later.

export type Job = { id: string; title: string; task: string; skill: string; pay: number; employer: string };
export type Application = { id: string; jobId: string; status: "applied" | "assessed" | "hired" | "paid"; verified: boolean };

const JOBS: Job[] = [
  { id: "j1", title: "Audio transcription — 30 min interview", task: "Transcribe a 30-minute recorded interview into clean text.", skill: "transcription", pay: 12000, employer: "ClearVoice Media" },
  { id: "j2", title: "Yoruba → English translation", task: "Translate 800 words of Yoruba text into English.", skill: "translation", pay: 15000, employer: "Lingua NG" },
  { id: "j3", title: "Phone customer support — 2 hour shift", task: "Handle inbound support calls for an airtime vendor.", skill: "phone support", pay: 8000, employer: "TopUp Africa" },
  { id: "j4", title: "Audio data labeling — 100 clips", task: "Listen to 100 short clips and tag the language spoken.", skill: "audio QA", pay: 10000, employer: "DataSeed" },
];

type Worker = {
  id: string;
  name: string;
  email: string;
  accountReference?: string;
  accountNumber?: string;
  bankName?: string;
  payoutAccount?: string;
  payoutBankCode?: string;
  payoutAccountName?: string;
  applications: Application[];
};

const worker: Worker = { id: "demo-worker", name: "Aide Demo Worker", email: "demo-worker@aide.test", applications: [] };

// Lazily create the worker's real Monnify earnings account on first need.
export async function ensureAccount(): Promise<Worker> {
  if (worker.accountNumber) return worker;
  const ref = `aide-${randomUUID().slice(0, 8)}`;
  const account = await createReservedAccount({
    accountReference: ref,
    accountName: worker.name,
    customerName: worker.name,
    customerEmail: worker.email,
  });
  worker.accountReference = ref;
  worker.accountNumber = account.accounts[0].accountNumber;
  worker.bankName = account.accounts[0].bankName;
  return worker;
}

export function listJobs(skill?: string): Job[] {
  if (!skill) return JOBS;
  const q = skill.toLowerCase();
  return JOBS.filter((j) => j.skill.includes(q) || j.title.toLowerCase().includes(q));
}

export function getJob(id: string): Job | undefined {
  return JOBS.find((j) => j.id === id);
}

export function apply(jobId: string): Application {
  const existing = worker.applications.find((a) => a.jobId === jobId);
  if (existing) return existing;
  const app: Application = { id: randomUUID().slice(0, 8), jobId, status: "applied", verified: false };
  worker.applications = [...worker.applications, app];
  return app;
}

export function getApplications(): Application[] {
  return worker.applications;
}

export function markVerified(jobId: string): Application | undefined {
  const app = worker.applications.find((a) => a.jobId === jobId);
  if (app) {
    app.verified = true;
    app.status = "assessed";
  }
  return app;
}

export function setPayout(account: string, bankCode: string, accountName: string): void {
  worker.payoutAccount = account;
  worker.payoutBankCode = bankCode;
  worker.payoutAccountName = accountName;
}

// Real balance: sum of PAID inbound payments to the reserved account.
export async function getBalance(): Promise<{ balance: number; account?: string }> {
  await ensureAccount();
  if (!worker.accountReference) return { balance: 0 };
  const { content } = await getReservedAccountTransactions(worker.accountReference);
  const balance = content.filter((t) => t.paymentStatus === "PAID").reduce((s, t) => s + t.amount, 0);
  return { balance, account: worker.accountNumber };
}

export function snapshot() {
  return {
    accountNumber: worker.accountNumber,
    bankName: worker.bankName,
    payoutAccountName: worker.payoutAccountName,
    applications: worker.applications.map((a) => ({ ...a, job: getJob(a.jobId) })),
    jobs: JOBS,
  };
}

export function getWorker(): Worker {
  return worker;
}
