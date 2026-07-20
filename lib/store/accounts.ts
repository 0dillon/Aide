import { accounts, newId, worker, type Account, type Role, type Worker } from "./state";

// The only shape of an account that may be serialized to the browser.
export function publicAccount(a: Account): Omit<Account, "passwordHash"> & { authenticated: boolean } {
  const { passwordHash, ...rest } = a;
  return { ...rest, authenticated: !!passwordHash };
}

export function findAccountByEmail(email: string): Account | undefined {
  const q = email.trim().toLowerCase();
  return [...accounts.values()].find((a) => a.email?.toLowerCase() === q);
}

export function createAccount(name: string, role: Role, email?: string, passwordHash?: string): Account {
  // Profile starts completely empty — Aide's spoken onboarding (or the
  // profile page) fills skills and bio afterwards.
  const acc: Account = { id: `u-${newId()}`, name: name.trim(), email, role, createdAt: Date.now(), skills: [], bio: "", passwordHash };
  accounts.set(acc.id, acc);
  return acc;
}

export function getAccount(id?: string | null): Account {
  return (id && accounts.get(id)) || accounts.get("demo-worker")!;
}

export function listAccounts(): Account[] {
  return [...accounts.values()];
}

export function hasAccount(id: string): boolean {
  return accounts.has(id);
}

export function getWorker(): Worker {
  return worker;
}

// The account record is the source of truth for profile data. The legacy
// global worker record is kept in sync for the demo worker only (it still
// backs applications and the employer's applicant view).
export function updateProfile(
  userId: string,
  input: { name?: string; email?: string; skills?: string[]; bio?: string },
): { account: Account | undefined; worker: Worker } {
  const acc = accounts.get(userId);
  if (acc) {
    if (input.name !== undefined) acc.name = input.name.trim();
    if (input.email !== undefined) acc.email = input.email.trim();
    if (input.skills !== undefined) acc.skills = input.skills.map((s) => s.trim()).filter(Boolean);
    if (input.bio !== undefined) acc.bio = input.bio.trim();
  }

  if (userId === worker.id) {
    if (input.name !== undefined) worker.name = input.name.trim();
    if (input.email !== undefined) worker.email = input.email.trim();
    if (input.skills !== undefined) worker.skills = input.skills.map((s) => s.trim()).filter(Boolean);
    if (input.bio !== undefined) worker.bio = input.bio.trim();
  }
  return { account: acc, worker };
}
