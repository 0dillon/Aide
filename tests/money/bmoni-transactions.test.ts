import { describe, expect, it } from "vitest";
import { parseWalletTransactions } from "../../lib/banking/bmoni-shapes";

// Wallet transaction history. The envelope below was captured live from
// GET /v1/users/{userId}/smart-wallets/{smartWalletId}/transactions on
// 2026-09-04; no wallet on the shared sandbox has a transaction yet, so the
// ITEM field names come from the SDK's EmbeddedWalletTransaction model rather
// than from observed JSON.
//
// That asymmetry is why this parser throws on an item it cannot read instead
// of skipping it. If the names are wrong, the page must say it could not list
// the payments — loudly and once — rather than quietly rendering a short list
// and letting a worker conclude that a payment never arrived.

const envelope = (transactions: unknown[]) => ({
  transactions,
  page: 1,
  perPage: 50,
  total: transactions.length,
  pageCount: 1,
  hasNextPage: false,
  hasPreviousPage: false,
});

describe("wallet transactions", () => {
  it("reads an empty history as genuinely empty", () => {
    // This is now a real answer from the provider, not a gap in the API. It
    // means no money has arrived — which the page is entitled to say.
    expect(parseWalletTransactions(envelope([]))).toEqual([]);
  });

  it("reads an incoming credit in kobo", () => {
    const [c] = parseWalletTransactions(
      envelope([
        {
          id: "tx-1",
          amount: 12000.5,
          currency: "NGN",
          direction: "incoming",
          status: "completed",
          counterpartyName: "ClearVoice Media",
          createdAt: "2026-09-04T01:00:00.000Z",
        },
      ]),
    );
    expect(c).toEqual({
      amountKobo: 1_200_050,
      reference: "tx-1",
      from: "ClearVoice Media",
      at: Date.parse("2026-09-04T01:00:00.000Z"),
    });
  });

  it("leaves out money going the other way", () => {
    // Money out is Aide's own withdrawal ledger, which it can vouch for.
    // Counting an outgoing transfer as a credit would inflate what a worker
    // believes has been paid to them.
    expect(
      parseWalletTransactions(
        envelope([{ id: "tx-2", amount: 5000, direction: "outgoing", status: "completed", createdAt: 1 }]),
      ),
    ).toEqual([]);
  });

  it("leaves out a credit that has not completed", () => {
    // Aide announces money as ARRIVED. A pending credit has not arrived, and
    // reversed means it left again.
    for (const status of ["pending", "failed", "reversed"]) {
      expect(
        parseWalletTransactions(
          envelope([{ id: "tx-3", amount: 5000, direction: "incoming", status, createdAt: 1 }]),
        ),
      ).toEqual([]);
    }
  });

  it("throws rather than skipping a credit it cannot price", () => {
    // A silently dropped row is a payment the worker was never told about.
    expect(() =>
      parseWalletTransactions(envelope([{ id: "tx-4", direction: "incoming", status: "completed" }])),
    ).toThrow(/amount/i);
  });

  it("throws when the response is not a transaction list", () => {
    expect(() => parseWalletTransactions({})).toThrow(/transactions/);
  });
});
