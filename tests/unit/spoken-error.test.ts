import { describe, expect, it } from "vitest";
import { spokenClientError } from "../../lib/spoken-error";

// Aide reads these aloud. The regression this guards is real: a blind user was
// read "The operation was aborted due to timeout", word for word, with no
// retry button they could see.
describe("spokenClientError", () => {
  const machineText = [
    "The operation was aborted due to timeout",
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "fetch failed: ECONNREFUSED 127.0.0.1:3000",
    "getaddrinfo ENOTFOUND sandbox.monnify.com",
    "UND_ERR_CONNECT_TIMEOUT",
    "Aide had a problem (status 500).",
    "Server error: Convex may be unreachable.",
    "Internal Server Error",
    "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
  ];

  it.each(machineText)("never reads machine text aloud: %s", (raw) => {
    const spoken = spokenClientError(raw);
    expect(spoken).not.toBe(raw);
    expect(spoken).not.toMatch(/abort|ECONN|ENOTFOUND|UND_ERR|DOMException|status \d{3}|DOCTYPE/i);
    // Whatever it says, it has to be a sentence a listener can act on.
    expect(spoken).toMatch(/try again|check the internet/i);
  });

  it("tells the user it lost the connection when the fetch never left", () => {
    expect(spokenClientError("Failed to fetch")).toMatch(/lost my connection/i);
  });

  it("tells the user it stopped waiting on a timeout", () => {
    expect(spokenClientError("The operation was aborted due to timeout")).toMatch(/too long/i);
  });

  it("reassures that a server-side failure is not about their account", () => {
    expect(spokenClientError("Internal Server Error")).toMatch(/not with your account/i);
  });

  it("passes a real sentence through untouched", () => {
    const real = "Bank details not found — check the account number and bank, then try again.";
    expect(spokenClientError(real)).toBe(real);
  });

  it("passes Aide's own spoken provider errors through untouched", () => {
    const real = "The bank did not answer in time, so I could not check your balance.";
    expect(spokenClientError(real)).toBe(real);
  });

  it("still says something when the message is empty", () => {
    expect(spokenClientError("")).toMatch(/try again/i);
  });
});
