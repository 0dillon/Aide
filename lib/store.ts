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
  pendingWithdrawal?: PendingWithdrawal;
  applications: Application[];
};

// A withdrawal armed but not yet executed. The user must speak `phrase` back
// before the transfer runs — voice consent replacing a visual OTP.
export type PendingWithdrawal = { amount: number; phrase: string; createdAt: number };

const CONFIRM_WORDS = ["mango", "sunrise", "guitar", "river", "orange", "candle", "harvest", "compass"];
const PENDING_TTL_MS = 5 * 60 * 1000;

function makeConfirmPhrase(): string {
  return CONFIRM_WORDS[Math.floor(Math.random() * CONFIRM_WORDS.length)];
}

// Loose match: the user may say "mango" or "the word is mango". ASR is imperfect,
// so we check the confirm word appears among the spoken tokens.
function phraseMatches(spoken: string, phrase: string): boolean {
  return spoken
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .includes(phrase);
}

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

// Step 1 of withdrawal: arm it. Returns the details Aide must read back plus the
// confirm word the user must speak. No money moves here.
export function armWithdrawal(amount: number):
  | { ok: true; amount: number; accountName: string; account: string; phrase: string }
  | { ok: false; message: string } {
  if (!worker.payoutAccount || !worker.payoutBankCode || !worker.payoutAccountName) {
    return { ok: false, message: "No payout account saved yet. Register one first." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Amount must be a positive number." };
  }
  const phrase = makeConfirmPhrase();
  worker.pendingWithdrawal = { amount, phrase, createdAt: Date.now() };
  return { ok: true, amount, accountName: worker.payoutAccountName, account: worker.payoutAccount, phrase };
}

// Step 2 of withdrawal: verify the spoken confirmation against the armed phrase.
// Only a match (within TTL) authorizes the transfer. This is the accessible 2FA gate.
export function verifyWithdrawal(spokenPhrase: string):
  | { ok: true; amount: number; account: string; bankCode: string; accountName: string }
  | { ok: false; message: string } {
  const pending = worker.pendingWithdrawal;
  if (!pending) return { ok: false, message: "No withdrawal is awaiting confirmation. Start one first." };
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    worker.pendingWithdrawal = undefined;
    return { ok: false, message: "The confirmation timed out. Please start the withdrawal again." };
  }
  if (!phraseMatches(spokenPhrase, pending.phrase)) {
    return { ok: false, message: `That didn't match. Ask them to say the word "${pending.phrase}" to confirm.` };
  }
  worker.pendingWithdrawal = undefined;
  return {
    ok: true,
    amount: pending.amount,
    account: worker.payoutAccount!,
    bankCode: worker.payoutBankCode!,
    accountName: worker.payoutAccountName!,
  };
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
    awaitingWithdrawalConfirmation: worker.pendingWithdrawal
      ? { amount: worker.pendingWithdrawal.amount }
      : undefined,
    applications: worker.applications.map((a) => ({ ...a, job: getJob(a.jobId) })),
    jobs: JOBS,
  };
}

export function getWorker(): Worker {
  return worker;
}
