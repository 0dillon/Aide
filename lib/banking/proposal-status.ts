// What Aide is allowed to SAY about a transfer, given what BMONI reported.
//
// This is ARCHITECTURE.md's rule at its sharpest: the model never decides a
// financial fact, it only narrates what a tool returned this turn. So the tool
// must be certain. There are three honest answers — done, still going, or
// failed — and anything that does not clearly mean one of those resolves to "I
// do not know".
//
// The asymmetry is deliberate. Calling a completed transfer "still going"
// costs a worker one more question. Calling an unknown one "completed" tells
// someone who cannot see the screen that their wages arrived when they did
// not, and they have no way to discover otherwise until they try to spend it.
//
// Mapping is exact and case-sensitive on purpose. A status that merely looks
// like success — "SUCCESS", "SETTLED", "completed" — is a status we have not
// seen documented, and guessing that it means the same thing is the guess this
// module exists to prevent.

export type ProposalState = "completed" | "pending" | "failed" | "unknown";

export type ProposalOutcome = {
  state: ProposalState;
  // The status exactly as BMONI sent it. An unknown state is an operational
  // event someone has to chase, and losing the string makes it undiagnosable.
  raw: string;
  // The only gate that should decide whether Aide says the money arrived.
  mayAnnounceArrival: boolean;
};

// Every status BMONI documents for a proposal. Adding to this list is a
// deliberate act, which is the point — a new status arriving from the provider
// should surface as "unknown" and be looked at, not silently absorbed.
const COMPLETED = new Set(["COMPLETED"]);
const PENDING = new Set(["PENDING_APPROVALS", "PENDING_SIGNATURES", "EXECUTING"]);
const FAILED = new Set(["FAILED"]);

export function readProposalOutcome(status: string): ProposalOutcome {
  // Anything that is not a string is a malformed payload, not a status.
  const raw = typeof status === "string" ? status : "";
  const state: ProposalState = COMPLETED.has(raw)
    ? "completed"
    : PENDING.has(raw)
      ? "pending"
      : FAILED.has(raw)
        ? "failed"
        : "unknown";
  return { state, raw, mayAnnounceArrival: state === "completed" };
}
