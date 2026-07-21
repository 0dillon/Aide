import { randomUUID } from "node:crypto";

// In-memory demo state. One seeded worker. Real Monnify reserved account +
// real balance from confirmed inbound payments. Swap for Convex/Postgres later.
//
// All mutable state hangs off globalThis. Next.js dev bundles each API route
// separately, so a plain module-level singleton silently forks into one copy
// per route — applications created by /api/jobs/apply would be invisible to
// /api/jobs/status. globalThis is shared by the whole Node process.

export type McqQuestion = {
  question: string;
  options: string[];
  correctIndex: number;
};

export type Job = {
  id: string;
  title: string;
  task: string;
  skill: string;
  pay: number;
  employer: string;
  requiresAssessment: boolean;
  assessmentType?: "oral" | "mcq";
  // Employer-written spoken-assessment question; when absent, a generic
  // prompt is derived from the task.
  assessmentQuestion?: string;
  mcqQuestions?: McqQuestion[];
  timeLimit?: number; // in seconds (optional)
};

export type Application = {
  id: string;
  jobId: string;
  // "cancelled" = the worker abandoned the assessment; the job is permanently
  // locked for them — no retake, no re-application.
  status: "applied" | "assessed" | "hired" | "rejected" | "paid" | "cancelled";
  verified: boolean;
  // Human-readable assessment outcome for the employer, e.g. "MCQ: 2 of 2 (100%)".
  assessmentResult?: string;
};

// External listings Aide found on the open web, matched to the worker's skills.
export type ExternalJob = { id: string; title: string; company: string; url: string; skill: string; source: string };
export type ExternalApplication = { id: string; externalJobId: string; title: string; company: string; url: string; status: "tracked"; at: number };

// Accounts are demo-grade on purpose: a name and a chosen role, no passwords.
// The signed-in account travels in an `aide-user` cookie; unknown or absent
// ids fall back to the seeded demo worker so every flow still works cold.
export type Role = "worker" | "employer";
export type Account = {
  id: string;
  name: string;
  email?: string;
  role: Role;
  createdAt: number;
  // Per-account profile. New accounts start completely empty — Aide offers a
  // spoken onboarding to fill these, or they can be edited on the profile page.
  skills: string[];
  bio: string;
  // Present on real credentialed accounts; absent on the passwordless demo
  // identities. Never leaves the server — always strip via publicAccount().
  passwordHash?: string;
};

// A record of money leaving via voice-confirmed withdrawal — Monnify has no
// cheap "list my disbursements" call, so the app keeps its own ledger. Also
// what makes balances honest: available = confirmed inbound − withdrawals.
export type WithdrawalRecord = { accountId: string; amount: number; accountName: string; status: string; at: number };

// A withdrawal armed but not yet executed. The user must speak `phrase` back
// before the transfer runs — voice consent replacing a visual OTP.
export type PendingWithdrawal = { amount: number; phrase: string; createdAt: number };

// One Monnify wallet (dedicated reserved NUBAN) per Aide account. The
// accountReference is deterministic (aide-<accountId>) so the same real
// NUBAN is reattached across server restarts — Monnify allows exactly one
// reserved account per reference/customer.
export type Wallet = {
  accountId: string;
  accountReference: string;
  status: "unprovisioned" | "active" | "failed";
  accountNumber?: string;
  bankName?: string;
  lastError?: string;
  payoutAccount?: string;
  payoutBankCode?: string;
  payoutAccountName?: string;
  // When the payout destination was last changed (new-beneficiary hold).
  payoutSetAt?: number;
  pendingWithdrawal?: PendingWithdrawal;
  // Payment-event bookkeeping, per wallet: which inbound transactions have
  // already been announced, and whether history was seeded silently.
  knownTxRefs: Set<string>;
  txSeeded: boolean;
  balanceCache?: { value: number; at: number };
};

export type Worker = {
  id: string;
  name: string;
  email: string;
  skills: string[];
  bio: string;
  applications: Application[];
};

export type AideEvent =
  | { type: "payment"; amount: number; from: string; reference: string }
  | { type: "notify"; message: string };
export type Subscriber = (e: AideEvent) => void;

export type StoreState = {
  worker: Worker;
  accounts: Map<string, Account>;
  withdrawals: WithdrawalRecord[];
  jobs: Job[];
  attempts?: Map<string, number>;
  wallets?: Map<string, Wallet>;
  // Event subscribers, keyed by the account whose wallet they listen to.
  subscribersByAccount?: Map<string, Set<Subscriber>>;
  pollTimer?: ReturnType<typeof setInterval>;
  externalJobs?: ExternalJob[];
  externalApps?: ExternalApplication[];
};

const SEED_JOBS: Job[] = [
  { id: "j1", title: "Audio transcription — 30 min interview", task: "Transcribe a 30-minute recorded interview into clean text.", skill: "transcription", pay: 12000, employer: "ClearVoice Media", requiresAssessment: true },
  { id: "j2", title: "Yoruba → English translation", task: "Translate 800 words of Yoruba text into English.", skill: "translation", pay: 15000, employer: "Lingua NG", requiresAssessment: true },
  { id: "j3", title: "Phone customer support — 2 hour shift", task: "Handle inbound support calls for an airtime vendor.", skill: "phone support", pay: 8000, employer: "TopUp Africa", requiresAssessment: true },
  { id: "j4", title: "Audio data labeling — 100 clips", task: "Listen to 100 short clips and tag the language spoken.", skill: "audio QA", pay: 10000, employer: "DataSeed", requiresAssessment: false },
];

function seedState(): StoreState {
  const w: Worker = {
    id: "demo-worker",
    name: "Aide Demo Worker",
    email: "aide-demo-worker@aide.test",
    skills: ["audio transcription", "translation", "data entry"],
    bio: "Experienced transcriber fluent in English and Yoruba. Detail-oriented and dedicated to delivering clean text under tight schedules.",
    applications: [],
  };
  const accs = new Map<string, Account>();
  accs.set("demo-worker", { id: "demo-worker", name: w.name, email: w.email, role: "worker", createdAt: Date.now(), skills: [...w.skills], bio: w.bio });
  accs.set("demo-employer", { id: "demo-employer", name: "ClearVoice Media", role: "employer", createdAt: Date.now(), skills: [], bio: "" });
  return { worker: w, accounts: accs, withdrawals: [], jobs: [...SEED_JOBS], attempts: new Map<string, number>() };
}

const g = globalThis as unknown as { __aideStore?: StoreState };
export const state = (g.__aideStore ??= seedState());
// The state object can outlive code changes (HMR keeps globalThis) — backfill
// any fields added since it was first seeded.
state.jobs ??= [...SEED_JOBS];
state.withdrawals ??= [];
state.attempts ??= new Map<string, number>();
state.wallets ??= new Map<string, Wallet>();
state.subscribersByAccount ??= new Map<string, Set<Subscriber>>();
state.externalJobs ??= [];
state.externalApps ??= [];
// Accounts created before per-account profiles existed get empty ones.
for (const a of state.accounts.values()) {
  a.skills ??= a.id === "demo-worker" ? [...state.worker.skills] : [];
  a.bio ??= a.id === "demo-worker" ? state.worker.bio : "";
}

export const worker = state.worker;
export const accounts = state.accounts;
export const withdrawals = state.withdrawals;
export const JOBS = state.jobs;
export const attempts = state.attempts!;
export const wallets = state.wallets!;

export const newId = (len = 8) => randomUUID().slice(0, len);
