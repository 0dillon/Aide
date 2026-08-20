import { getFunctionName } from "convex/server";

// A stand-in for the Convex transport, used when the thing under test is the
// SERVER-SIDE decision rather than the database logic. The real Convex handlers
// have their own suite (tests/convex) that runs them for real; here we care
// about what the store decides to ask for, and what it does with the answer.
//
// Every call is recorded, so a test can assert not just the outcome but that
// the right thing was written — "no transfer was armed" is a different claim
// from "the caller was told no".

export type ConvexCall = { name: string; args: any };
export type Handlers = Record<string, (args: any) => any>;

export function makeDispatch(handlers: Handlers, calls: ConvexCall[]) {
  return (ref: any, args: any) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) {
      throw new Error(
        `fake convex: no handler for "${name}". Add one to the test so the ` +
          `call is deliberate rather than silently mocked away.`,
      );
    }
    return Promise.resolve(handler(args));
  };
}

// The wallet shape the store expects back from Convex.
export const walletDoc = (over: Record<string, unknown> = {}) => ({
  accountId: "u-worker",
  accountReference: "aide-u-worker",
  status: "active" as const,
  accountNumber: "1234567890",
  bankName: "Wema Bank",
  knownTxRefs: [],
  txSeeded: true,
  ...over,
});

export const accountDoc = (over: Record<string, unknown> = {}) => ({
  key: "u-worker",
  name: "Ada Okafor",
  role: "worker" as const,
  skills: [],
  bio: "",
  preferences: [],
  createdAt: Date.now(),
  ...over,
});
