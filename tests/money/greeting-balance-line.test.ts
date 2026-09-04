import { describe, expect, it } from "vitest";
import { balanceLine } from "../../lib/greeting-balance";

// What Aide says about money in its opening breath.
//
// The person listening cannot see the screen, so silence has to mean exactly
// one thing. Before this, a balance of zero was skipped entirely — the same
// silence as a balance that had not come back yet. "You have nothing" and "I
// have not checked" sounded identical, and only one of them is a reason to
// stop waiting for wages to land.
//
// So: a known balance is always stated, zero included. Silence now means only
// that the figure was not back in time, and the user can ask again.

describe("the balance line in the greeting", () => {
  it("states a real balance", () => {
    expect(balanceLine(12000)).toBe("You have ₦12,000.00 in your account, ready to withdraw.");
  });

  it("states zero out loud instead of skipping it", () => {
    // The bug this file exists for. A worker with nothing must hear so.
    expect(balanceLine(0)).toBe("Your balance is ₦0.00 right now.");
  });

  it("says nothing when the figure never arrived", () => {
    // Not an error — the greeting gives the balance 2.5s so Aide can start
    // speaking promptly. Saying "I could not check" every slow morning would
    // alarm people about a delay that is routine. Asking again is cheap.
    expect(balanceLine(null)).toBeNull();
  });

  it("does not describe an empty account as ready to withdraw", () => {
    expect(balanceLine(0)).not.toMatch(/ready to withdraw/);
  });

  it("shows kobo rather than rounding them away", () => {
    // A worker owed ₦12,000.50 who hears "twelve thousand naira" has been told
    // a number that is not theirs.
    expect(balanceLine(12000.5)).toContain("₦12,000.50");
  });
});
