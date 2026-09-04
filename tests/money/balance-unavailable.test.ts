import { beforeEach, describe, expect, it, vi } from "vitest";

// When the bank rail is slow or down, the payments page used to fail whole and
// read the raw failure aloud — a blind user in production was told "The
// operation was aborted due to timeout", which is a DOMException message, not
// a sentence. Everything except the balance lives in our own database and had
// no reason to go with it.
//
// The rule this file defends: unknown is not zero. A balance nobody could
// verify must come back null and be SAID, never rendered as a number.

const store = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getBalance: vi.fn(),
  getWallet: vi.fn(),
}));
const session = vi.hoisted(() => ({ userIdFrom: vi.fn(() => "u-worker") }));

vi.mock("@/lib/store", () => store);
vi.mock("@/lib/session", () => session);

const { GET } = await import("../../app/api/payments/summary/route");
const { spokenProviderError } = await import("../../lib/monnify");

const ACCOUNT = { id: "u-worker", name: "Ada Okafor", role: "worker", skills: [], bio: "", createdAt: 1 };
const WALLET = {
  accountNumber: "1234567890",
  bankName: "Wema Bank",
  payoutAccount: "0987654321",
  payoutAccountName: "Ada Okafor",
  hasSecurityPhrase: true,
  pendingWithdrawal: null,
};

const ask = async () => {
  const res = await GET(new Request("http://localhost/api/payments/summary"));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  // These exercise the Monnify adapter specifically — the Monnify HTTP module
  // is what they mock. BMONI is the default provider now, so the rail under
  // test is named rather than assumed; without this they would run against
  // BMONI and fail on a missing sandbox user rather than on anything they are
  // actually asserting.
  vi.stubEnv("AIDE_PAYMENT_PROVIDER", "monnify");
  vi.clearAllMocks();
  store.getAccount.mockResolvedValue(ACCOUNT);
  store.getWallet.mockResolvedValue(WALLET);
});

describe("the payments summary when the bank answers", () => {
  it("returns the confirmed balance", async () => {
    store.getBalance.mockResolvedValue({ balance: 12000, account: "1234567890", bankName: "Wema Bank" });
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body.balance).toBe(12000);
    expect(body.balanceUnavailable).toBeUndefined();
  });
});

describe("the payments summary when the bank does not", () => {
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

  it("still loads the page rather than failing whole", async () => {
    store.getBalance.mockRejectedValue(timeout());
    const { status } = await ask();
    expect(status).toBe(200);
  });

  it("reports the balance as unknown, never as zero", async () => {
    // The difference that matters: a worker told "zero" believes they were
    // not paid. There is no way for them to check that against anything.
    store.getBalance.mockRejectedValue(timeout());
    const { body } = await ask();
    expect(body.balance).toBeNull();
    expect(body.balance).not.toBe(0);
  });

  it("says something a person could act on, not the raw failure", async () => {
    store.getBalance.mockRejectedValue(timeout());
    const { body } = await ask();
    expect(body.balanceUnavailable).toBeTruthy();
    expect(body.balanceUnavailable).not.toMatch(/DOMException|aborted|ENOTFOUND|ECONNREFUSED|undefined/i);
    // It has to reassure: the money is fine, this is a connection problem.
    expect(body.balanceUnavailable).toMatch(/safe/i);
    expect(body.balanceUnavailable).toMatch(/try again|moment/i);
  });

  it("still returns everything that does not come from the bank", async () => {
    // The account number, the bank name and the payout details are ours. There
    // was never a reason for them to disappear with the balance — a worker
    // still needs to be able to read out where to send money.
    store.getBalance.mockRejectedValue(timeout());
    const { body } = await ask();
    expect(body.accountNumber).toBe("1234567890");
    expect(body.bankName).toBe("Wema Bank");
    expect(body.payoutAccountName).toBe("Ada Okafor");
    expect(body.hasSecurityPhrase).toBe(true);
    expect(body.name).toBe("Ada Okafor");
  });

  it("survives the wallet lookup failing too", async () => {
    store.getBalance.mockRejectedValue(timeout());
    store.getWallet.mockRejectedValue(new Error("convex unreachable"));
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body.balance).toBeNull();
    expect(body.hasSecurityPhrase).toBe(false);
  });

  it("fails properly when the account itself cannot be loaded", async () => {
    // No account means no page. That one is a real error, and it must still
    // be a sentence rather than a stack trace.
    store.getAccount.mockRejectedValue(new Error("convex unreachable"));
    const { status, body } = await ask();
    expect(status).toBe(500);
    expect(body.error).toMatch(/try again/i);
  });
});

describe("what a provider failure sounds like", () => {
  it("turns a timeout into a sentence", () => {
    const said = spokenProviderError(Object.assign(new Error("The operation was aborted due to timeout"), {}));
    expect(said).toMatch(/did not answer in time/i);
    expect(said).toMatch(/safe/i);
  });

  it("turns an unreachable host into a sentence", () => {
    const said = spokenProviderError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    expect(said).toMatch(/could not reach/i);
    expect(said).toMatch(/safe/i);
  });

  it("never reads a raw error code aloud, whatever it is", () => {
    for (const raw of ["ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "socket hang up", ""]) {
      const said = spokenProviderError(new Error(raw));
      expect(said).not.toContain(raw === "" ? "\0" : raw);
      expect(said.length).toBeGreaterThan(20);
    }
  });

  it("never claims the balance is zero", () => {
    for (const raw of ["timeout", "ENOTFOUND", "boom"]) {
      expect(spokenProviderError(new Error(raw))).not.toMatch(/\bzero\b|\b0 naira\b/i);
    }
  });
});

describe("the temporary demo balance stand-in", () => {
  // A number this app otherwise refuses to invent. It exists so a demo can
  // survive a provider outage, which makes "off unless deliberately switched
  // on" the property that matters most.
  it("is off unless the variable is set, so an outage still says it could not check", async () => {
    vi.stubEnv("AIDE_DEMO_BALANCE", "");
    store.getBalance.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    const { body } = await ask();
    expect(body.balance).toBeNull();
    expect(body.balanceUnavailable).toBeTruthy();
    vi.unstubAllEnvs();
  });

  it("never replaces a real balance the bank did return", async () => {
    vi.stubEnv("AIDE_DEMO_BALANCE", "12000");
    store.getBalance.mockResolvedValue({ balance: 250, account: "1234567890", bankName: "Wema Bank" });
    const { body } = await ask();
    expect(body.balance).toBe(250);
    vi.unstubAllEnvs();
  });
});
