import { createHash } from "node:crypto";

// A Nigerian E.164 phone number for a demo persona, unique to this deployment.
//
// BMONI enforces global uniqueness on phoneNumber across every team sharing the
// development sandbox, and the two documented persona numbers
// (+2348000000000 / +2348000000001) are the first thing anyone reaches for.
// They are already registered to other teams, so creating a user with one
// returns "409 User already exists with this phoneNumber" — and because the
// existing record carries someone else's email, the conflict recovery
// correctly refuses to adopt it rather than binding a worker to a stranger's
// wallet.
//
// The phone is NOT part of identity matching. Verified against the sandbox: a
// user created with a generated number, the persona's real name and the
// persona's BVN still completed start-nigeria and was issued a virtual account
// in the persona's name. Only the BVN and the name are matched.
//
// Derived rather than random because it must be STABLE. A number that changed
// between calls would create a fresh BMONI user on every provisioning attempt,
// and smart-wallet creation has no uniqueness guard behind it.
export function personaPhone(accountId: string, deployment: string): string {
  const digits = createHash("sha256").update(`aide-persona:${deployment}:${accountId}`).digest("hex").replace(/\D/g, "");
  // 0803… is a real Nigerian mobile prefix range; 9 more digits after the 8.
  return `+2348${digits.slice(0, 9).padEnd(9, "0")}`;
}

// The deployment this app is pointed at, used to keep two clones of the repo
// from claiming the same numbers.
export function currentDeployment(): string {
  return process.env.CONVEX_DEPLOYMENT?.trim() || process.env.NEXT_PUBLIC_CONVEX_URL?.trim() || "local";
}
