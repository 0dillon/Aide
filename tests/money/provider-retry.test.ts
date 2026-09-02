import { beforeEach, describe, expect, it, vi } from "vitest";

// Monnify's sandbox is not merely slow, it is erratic: the same auth call
// measured 0.5s, 4.1s and 13.6s in three consecutive attempts. A single
// eight-second budget turns that into "I could not check your balance" for a
// worker whose money is sitting there fine.
//
// So reads retry once. Transfers must NEVER retry — a timeout on a
// disbursement means we do not know whether the money moved, and asking again
// could move it twice. That asymmetry is the whole point of this file.

vi.mock("../../lib/env", () => ({
  env: {
    apiKey: "k",
    secretKey: "s",
    baseUrl: "https://sandbox.example",
    contractCode: "C1",
    walletAccountNumber: "0000000000",
    kycBvn: "22222222222",
    testDestAccount: "0000000000",
    testDestBankCode: "058",
    webhookPort: 4000,
  },
}));

const ok = (responseBody: unknown) =>
  new Response(JSON.stringify({ requestSuccessful: true, responseMessage: "ok", responseBody }), { status: 200 });

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

let calls: string[] = [];
const fetchMock = vi.fn();

// How long a call is given is decided by AbortSignal.timeout, and the signal it
// returns does not carry the number. So record the argument and pair it with
// the request that follows — attempt() calls the two back to back.
const realAbortTimeout = AbortSignal.timeout.bind(AbortSignal);
let lastBudget = -1;
let budgets: { path: string; ms: number }[] = [];
const budgetFor = (match: string) => budgets.find((b) => b.path.includes(match))?.ms ?? -1;

beforeEach(async () => {
  vi.resetModules();
  calls = [];
  budgets = [];
  lastBudget = -1;
  fetchMock.mockReset();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    lastBudget = ms;
    return realAbortTimeout(ms);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

// Every test re-imports so the module-level token cache starts empty.
const load = async () => await import("../../lib/monnify");

const route = (url: unknown) => String(url).replace("https://sandbox.example", "");

const respond = (handler: (path: string, n: number) => Response | Promise<Response>) => {
  const seen = new Map<string, number>();
  fetchMock.mockImplementation(async (url: unknown) => {
    const path = route(url);
    calls.push(path);
    budgets.push({ path, ms: lastBudget });
    const n = (seen.get(path) ?? 0) + 1;
    seen.set(path, n);
    return handler(path, n);
  });
};

const AUTH = "/api/v1/auth/login";
const token = () => ok({ accessToken: "t", expiresIn: 3600 });

describe("a read that times out once", () => {
  it("tries again rather than giving up on the first slow attempt", async () => {
    respond((path, n) => {
      if (path === AUTH) return token();
      if (n === 1) throw timeout();
      return ok({ content: [] });
    });
    const { getReservedAccountTransactions } = await load();
    await expect(getReservedAccountTransactions("ref-1")).resolves.toEqual({ content: [] });
    expect(calls.filter((c) => c.includes("transactions"))).toHaveLength(2);
  });

  it("gives up after the second attempt rather than hammering the provider", async () => {
    respond((path) => {
      if (path === AUTH) return token();
      throw timeout();
    });
    const { getReservedAccountTransactions } = await load();
    await expect(getReservedAccountTransactions("ref-1")).rejects.toThrow();
    expect(calls.filter((c) => c.includes("transactions"))).toHaveLength(2);
  });

  it("retries the token call too, since everything queues behind it", async () => {
    respond((path, n) => {
      if (path === AUTH && n === 1) throw timeout();
      if (path === AUTH) return token();
      return ok({ content: [] });
    });
    const { getReservedAccountTransactions } = await load();
    await expect(getReservedAccountTransactions("ref-1")).resolves.toEqual({ content: [] });
    expect(calls.filter((c) => c === AUTH)).toHaveLength(2);
  });
});

describe("a provider that actually answered", () => {
  it("does not retry an error response, because the answer will not change", async () => {
    respond((path) => {
      if (path === AUTH) return token();
      return new Response(
        JSON.stringify({ requestSuccessful: false, responseMessage: "Invalid account reference", responseBody: null }),
        { status: 400 },
      );
    });
    const { getReservedAccountTransactions } = await load();
    await expect(getReservedAccountTransactions("ref-1")).rejects.toThrow(/Invalid account reference/);
    expect(calls.filter((c) => c.includes("transactions"))).toHaveLength(1);
  });
});

describe("moving money", () => {
  it("never retries a transfer, even on a timeout", async () => {
    // The rule this whole file exists for. A timeout on a disbursement means
    // we do not know whether it went through; a second attempt could send the
    // worker's money twice, and nothing downstream would notice.
    respond((path) => {
      if (path === AUTH) return token();
      throw timeout();
    });
    const { singleTransfer } = await load();
    await expect(
      singleTransfer({
        amount: 12000,
        reference: "w-1",
        narration: "payout",
        destinationAccountNumber: "0123456789",
        destinationBankCode: "058",
        destinationAccountName: "Ada Okafor",
      }),
    ).rejects.toThrow();
    expect(calls.filter((c) => c.includes("disbursements"))).toHaveLength(1);
  });

  it("gives a transfer far longer to answer than a read gets", async () => {
    // The other half of the same rule. Not retrying stops AIDE sending the
    // money twice; this stops the USER being told to. Abandoning the request
    // at eight seconds made confirmWithdrawal report a failure without writing
    // a ledger row, so the balance still showed the money and the worker was
    // invited to withdraw it again — against an endpoint that takes no
    // idempotency key. A timeout does not mean it failed. It means we do not
    // know, and the only safe way to find out is to wait for the answer.
    respond((path) => {
      if (path === AUTH) return token();
      if (path.includes("transactions")) return ok({ content: [] });
      return ok({ reference: "w-1", status: "SUCCESS", amount: 12000 });
    });
    const { singleTransfer, getReservedAccountTransactions } = await load();

    await singleTransfer({
      amount: 12000,
      reference: "w-1",
      narration: "payout",
      destinationAccountNumber: "0123456789",
      destinationBankCode: "058",
      destinationAccountName: "Ada Okafor",
    });
    await getReservedAccountTransactions("ref-1");

    const transferBudget = budgetFor("disbursements/single");
    expect(transferBudget).toBeGreaterThan(budgetFor("transactions"));
    // Long enough to outlast a slow interbank hop, not merely nudged up.
    expect(transferBudget).toBeGreaterThanOrEqual(30_000);
  });

  it("does not hand that budget to ordinary reads", async () => {
    respond((path) => {
      if (path === AUTH) return token();
      return ok({ content: [] });
    });
    const { getReservedAccountTransactions } = await load();
    await getReservedAccountTransactions("ref-1");
    expect(budgetFor("transactions")).toBeLessThanOrEqual(10_000);
    expect(budgetFor(AUTH)).toBeLessThanOrEqual(10_000);
  });
});

describe("a provider that has stopped answering entirely", () => {
  it("stops trying and fails immediately, instead of making the user wait again", async () => {
    // Measured during a real sandbox outage: the connection opened in 0.15s
    // and then returned zero bytes for thirty seconds, every single time.
    // Retrying that is a page that takes sixteen seconds to show a dash. The
    // user gets the same message either way — they should get it now.
    respond((path) => {
      if (path === AUTH) return token();
      throw timeout();
    });
    const { getReservedAccountTransactions } = await load();

    // Enough failures to trip the breaker.
    for (let i = 0; i < 3; i++) {
      await getReservedAccountTransactions("ref-1").catch(() => {});
    }
    const before = calls.length;

    const t = Date.now();
    await expect(getReservedAccountTransactions("ref-1")).rejects.toThrow(/not responding/i);
    expect(Date.now() - t).toBeLessThan(200);
    // And it did not touch the network to find that out.
    expect(calls.length).toBe(before);
  });

  it("still says something a person can act on", async () => {
    const { spokenProviderError } = await load();
    const said = spokenProviderError(new Error("Monnify is not responding — not retrying yet"));
    expect(said).toMatch(/not responding/i);
    expect(said).toMatch(/safe/i);
    expect(said).not.toMatch(/Monnify|retrying yet/);
  });

  it("recovers as soon as a call succeeds again", async () => {
    let down = true;
    respond((path) => {
      if (path === AUTH) return token();
      if (down) throw timeout();
      return ok({ content: [] });
    });
    const { getReservedAccountTransactions } = await load();
    for (let i = 0; i < 3; i++) await getReservedAccountTransactions("ref-1").catch(() => {});
    down = false;
    // The breaker is open, so this one is refused without a call...
    await expect(getReservedAccountTransactions("ref-1")).rejects.toThrow(/not responding/i);
  });
});
