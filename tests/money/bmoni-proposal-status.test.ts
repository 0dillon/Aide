import { describe, expect, it } from "vitest";
import { readProposalOutcome } from "../../lib/banking/proposal-status";

// What Aide is allowed to SAY about a transfer, given what BMONI reported.
//
// This is the rule from ARCHITECTURE.md at its sharpest: the model never
// decides a financial fact, it only narrates what a tool returned. So the tool
// has to be certain, and there are only three honest answers — it is done, it
// is still going, or it failed. Anything BMONI says that does not clearly mean
// one of those must resolve to "I do not know", never to "done".
//
// The asymmetry is the point. Calling a completed transfer "still going" costs
// a worker a second question. Calling an unknown one "completed" tells someone
// who cannot see the screen that money arrived when it did not.

describe("statuses BMONI documents", () => {
  it("treats COMPLETED as settled", () => {
    expect(readProposalOutcome("COMPLETED")).toEqual({
      state: "completed",
      raw: "COMPLETED",
      mayAnnounceArrival: true,
    });
  });

  it("treats the pending states as still moving", () => {
    expect(readProposalOutcome("PENDING_APPROVALS").state).toBe("pending");
    expect(readProposalOutcome("PENDING_SIGNATURES").state).toBe("pending");
    expect(readProposalOutcome("EXECUTING").state).toBe("pending");
  });

  it("treats FAILED as failed", () => {
    expect(readProposalOutcome("FAILED").state).toBe("failed");
  });
});

describe("anything else fails closed", () => {
  it("does NOT call an unrecognised status completed", () => {
    // The whole rule. A new status shipped by BMONI must not become "your
    // money has arrived" by default.
    for (const s of ["SETTLED", "DONE", "OK", "SUCCESS", "APPROVED", "REVERSED", "CLAWED_BACK"]) {
      expect(readProposalOutcome(s).state).toBe("unknown");
    }
  });

  it("does not guess at empty, null, or malformed input", () => {
    for (const s of ["", "   ", null, undefined, 42, {}, []] as unknown[]) {
      expect(readProposalOutcome(s as string).state).toBe("unknown");
    }
  });

  it("keeps the raw status so it can be logged and chased", () => {
    // An unknown state is an operational event. Losing the string would make
    // it undiagnosable.
    expect(readProposalOutcome("WEIRD_NEW_STATE").raw).toBe("WEIRD_NEW_STATE");
  });

  it("is case-sensitive rather than helpfully lenient", () => {
    // "completed" lowercase is not a status BMONI documents. Accepting it
    // would mean guessing that a different-looking payload means the same
    // thing, which is exactly the guess this file exists to prevent.
    expect(readProposalOutcome("completed").state).toBe("unknown");
  });
});

describe("what Aide may say", () => {
  it("only permits a spoken confirmation when settled", () => {
    expect(readProposalOutcome("COMPLETED").mayAnnounceArrival).toBe(true);
    for (const s of ["PENDING_SIGNATURES", "EXECUTING", "FAILED", "MYSTERY"]) {
      expect(readProposalOutcome(s).mayAnnounceArrival).toBe(false);
    }
  });
});
