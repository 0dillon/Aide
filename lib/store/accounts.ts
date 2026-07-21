import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { newId, worker, type Account, type Role, type Worker } from "./state";

// Accounts are now backed by Convex (shared across serverless instances). The
// legacy in-memory `worker` record is still kept in sync for the demo worker
// only — it backs applications and the employer's applicant view until those
// domains move to Convex too.

type ConvexAccount = {
  key: string;
  name: string;
  role: Role;
  email?: string;
  passwordHash?: string;
  skills: string[];
  bio: string;
  createdAt: number;
};

function toAccount(a: ConvexAccount): Account {
  return {
    id: a.key,
    name: a.name,
    role: a.role,
    email: a.email,
    passwordHash: a.passwordHash,
    skills: a.skills,
    bio: a.bio,
    createdAt: a.createdAt,
  };
}

// Last-resort fallback if even the seeded demo worker is missing, so no path
// ever hangs on a null account.
const FALLBACK_WORKER: Account = {
  id: "demo-worker",
  name: worker.name,
  role: "worker",
  email: worker.email,
  createdAt: Date.now(),
  skills: [...worker.skills],
  bio: worker.bio,
};

// The only shape of an account that may be serialized to the browser.
export function publicAccount(a: Account): Omit<Account, "passwordHash"> & { authenticated: boolean } {
  const { passwordHash, ...rest } = a;
  return { ...rest, authenticated: !!passwordHash };
}

export async function findAccountByEmail(email: string): Promise<Account | undefined> {
  const a = (await convexClient().query(api.accounts.getByEmail, { email })) as ConvexAccount | null;
  return a ? toAccount(a) : undefined;
}

export async function createAccount(name: string, role: Role, email?: string, passwordHash?: string): Promise<Account> {
  // Profile starts completely empty — Aide's spoken onboarding (or the profile
  // page) fills skills and bio afterwards.
  const acc: Account = { id: `u-${newId()}`, name: name.trim(), email, role, createdAt: Date.now(), skills: [], bio: "", passwordHash };
  await convexClient().mutation(api.accounts.create, {
    key: acc.id,
    name: acc.name,
    role,
    email,
    passwordHash,
    skills: [],
    bio: "",
    createdAt: acc.createdAt,
  });
  return acc;
}

export async function getAccount(id?: string | null): Promise<Account> {
  const key = id || "demo-worker";
  let a = (await convexClient().query(api.accounts.getByKey, { key })) as ConvexAccount | null;
  if (!a && key !== "demo-worker") {
    a = (await convexClient().query(api.accounts.getByKey, { key: "demo-worker" })) as ConvexAccount | null;
  }
  return a ? toAccount(a) : FALLBACK_WORKER;
}

export async function listAccounts(): Promise<Account[]> {
  const all = (await convexClient().query(api.accounts.list, {})) as ConvexAccount[];
  return all.map(toAccount);
}

export async function hasAccount(id: string): Promise<boolean> {
  return !!(await convexClient().query(api.accounts.getByKey, { key: id }));
}

export function getWorker(): Worker {
  return worker;
}

// The account record (Convex) is the source of truth for profile data. The
// legacy global worker record is kept in sync for the demo worker only.
export async function updateProfile(
  userId: string,
  input: { name?: string; email?: string; skills?: string[]; bio?: string },
): Promise<{ account: Account | undefined; worker: Worker }> {
  await convexClient().mutation(api.accounts.updateProfile, {
    key: userId,
    name: input.name,
    email: input.email,
    skills: input.skills,
    bio: input.bio,
  });

  if (userId === worker.id) {
    if (input.name !== undefined) worker.name = input.name.trim();
    if (input.email !== undefined) worker.email = input.email.trim();
    if (input.skills !== undefined) worker.skills = input.skills.map((s) => s.trim()).filter(Boolean);
    if (input.bio !== undefined) worker.bio = input.bio.trim();
  }

  const account = await getAccount(userId);
  return { account, worker };
}
