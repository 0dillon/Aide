import { describe, expect, it } from "vitest";
import {
  parseBanks,
  parseVerifiedAccount,
  parseCreatedUser,
  parseCreatedWallet,
  parseNgnBalanceKobo,
  parseNgnDepositAccount,
  soleNgnWalletIndex,
} from "../../lib/banking/bmoni-shapes";

// Every payload in this file was captured from the live BMONI sandbox at
// https://embedded-dev.bmoni.com on 2026-09-03, not transcribed from the docs
// and not imagined. Three of these shapes did not match what the client
// assumed, and each mismatch was silent: the field simply came back
// `undefined` and got persisted or spoken as such.
//
// If BMONI changes a shape, these tests are the thing that notices. Parsing
// must therefore THROW on an unrecognised body rather than defaulting — a
// balance parser that falls back to zero would tell a worker with money in
// their account that they have none, out loud, with no screen to check it
// against.

describe("POST /v1/users", () => {
  // The response wraps the user. Reading `bmoniUserId` off the top level gives
  // undefined, which is then stored and used to build every later path as
  // `/v1/users/undefined/...`.
  const real = {
    user: {
      id: "930b5d40-572c-4835-939d-2b66adc380bd",
      identityId: "ac5c8320-8878-4635-9853-d8023b6bc0d4",
      bmoniUserId: "7c9cc36c-c055-48dc-a7d1-f22a071f97f3",
      firstName: "Aide",
      lastName: "Probe1788460408",
      email: "aide.probe.1788460408@aide.test",
      phoneNumber: "+2348088460408",
    },
  };

  it("takes bmoniUserId from inside the user wrapper", () => {
    expect(parseCreatedUser(real)).toEqual({ bmoniUserId: "7c9cc36c-c055-48dc-a7d1-f22a071f97f3" });
  });

  it("does not mistake the record id for the id every other endpoint keys on", () => {
    // `id` and `bmoniUserId` are both UUIDs and both present. Picking the wrong
    // one is not a type error and not a 400 — it is a 404 "User not found" on
    // the next call, long after the wrong value was persisted.
    expect(parseCreatedUser(real).bmoniUserId).not.toBe(real.user.id);
  });

  it("refuses a body with no bmoniUserId rather than returning undefined", () => {
    expect(() => parseCreatedUser({ user: { id: "930b5d40" } })).toThrow(/bmoniUserId/);
  });
});

describe("POST /v1/users/{id}/smart-wallets/create-managed", () => {
  // Neither field is named what the client expected: not `smartWalletId`, not
  // `address`. And the currency comes back NGN even though CNGN was asked for.
  const real = {
    id: "1e40b487-04fc-4c2c-ba23-1a29fb57ba86",
    currency: "NGN",
    walletAddress: "0x4DD616C8dcB767CD838e54dF97dd59B50068b6FA",
    isActive: true,
    createdByUserId: "7c9cc36c-c055-48dc-a7d1-f22a071f97f3",
  };

  it("reads the wallet id from `id` and the address from `walletAddress`", () => {
    expect(parseCreatedWallet(real)).toEqual({
      smartWalletId: "1e40b487-04fc-4c2c-ba23-1a29fb57ba86",
      address: "0x4DD616C8dcB767CD838e54dF97dd59B50068b6FA",
      currency: "NGN",
    });
  });

  it("refuses a wallet with no address", () => {
    // An address-less wallet stored as provisioned is a wallet that can never
    // be paid into, and nothing downstream would report why.
    expect(() => parseCreatedWallet({ id: "1e40b487" })).toThrow(/walletAddress/);
  });
});

describe("GET /v1/users/{id}/smart-wallets/account/balances", () => {
  const real = {
    smartAccountAddress: "0x4DD616C8dcB767CD838e54dF97dd59B50068b6FA",
    balances: [{ smartWalletId: "1e40b487-04fc-4c2c-ba23-1a29fb57ba86", currency: "NGN", balance: "0", error: null }],
  };

  it("reads a zero NGN balance as zero kobo", () => {
    expect(parseNgnBalanceKobo(real)).toBe(0);
  });

  it("reads the balance as naira, in whole kobo", () => {
    // `balance` is a STRING, and decimal. Number-coercing it and keeping naira
    // floats is the bug the kobo migration exists to prevent.
    const b = { ...real, balances: [{ ...real.balances[0], balance: "12000.50" }] };
    expect(parseNgnBalanceKobo(b)).toBe(1_200_050);
  });

  it("throws when the entry carries a provider-side error instead of reporting the balance", () => {
    // `error` is per-entry and lives inside a 200 response. A non-null error
    // means BMONI could not price this wallet; `balance` alongside it is not a
    // figure anyone should hear.
    const b = { ...real, balances: [{ ...real.balances[0], balance: "0", error: "upstream timeout" }] };
    expect(() => parseNgnBalanceKobo(b)).toThrow(/upstream timeout/);
  });

  it("throws rather than returning zero when there is no NGN wallet", () => {
    // Wallets on this platform can be USD. Falling through to 0 would present
    // "no naira wallet exists" as "your account is empty" — two different
    // facts, one of which tells a worker to stop waiting for their wages.
    const usd = { ...real, balances: [{ ...real.balances[0], currency: "USD" }] };
    expect(() => parseNgnBalanceKobo(usd)).toThrow(/NGN/);
  });

  it("throws on an empty balances array", () => {
    expect(() => parseNgnBalanceKobo({ ...real, balances: [] })).toThrow(/NGN/);
  });
});

describe("the ngnWalletIndex that start-nigeria demands", () => {
  // POST …/onboarding/start-nigeria answers 400 with all three required fields
  // when any is missing, captured live on 2026-09-04:
  //
  //   ["bvn must be a string", "ngnWalletAddress must be a string",
  //    "ngnWalletIndex must be a number conforming to the specified constraints"]
  //
  // The client only ever sent two of them, so the Nigerian rail never started,
  // so no virtual account was ever issued, so the deposit list held nothing but
  // BMONI's pooled house account — and the payments page showed the stale
  // Monnify NUBAN instead. One unsent integer, four symptoms.
  //
  // Nothing in any response carries the index. No endpoint returns it: not the
  // wallet, not the balances entry, not the user. So it is DERIVED, and the
  // only derivation that cannot be quietly wrong is the one below.
  const oneWallet = {
    smartAccountAddress: "0xbb7EF869d8A6451a721cCdB6816405d27Bd529F4",
    balances: [{ smartWalletId: "ce91a25e-694b-4bc7-8810-349c4b912f18", currency: "NGN", balance: "0", error: null }],
  };

  it("is 0 for the one wallet Aide provisions", () => {
    // Verified against the sandbox: index 0 with this exact wallet returned
    // 200 and the anchor rail went from not_started to active.
    expect(soleNgnWalletIndex(oneWallet, "ce91a25e-694b-4bc7-8810-349c4b912f18")).toBe(0);
  });

  it("refuses when the wallet being onboarded is not the one BMONI lists", () => {
    // Would otherwise hand back 0 and onboard somebody else's wallet under
    // this worker's BVN.
    expect(() => soleNgnWalletIndex(oneWallet, "00000000-0000-0000-0000-000000000000")).toThrow(/does not list/i);
  });

  it("refuses to pick an index when the user has more than one wallet", () => {
    // Position in this array is a GUESS, not a documented mapping — BMONI
    // never states whether its index counts every wallet or only the NGN ones.
    // A wrong index points a worker's incoming wages at a wallet Aide does not
    // read, and the money arrives somewhere real, so nothing errors. Refusing
    // is the only honest answer, and it cannot happen in practice: Aide creates
    // exactly one wallet per user and provisioning already refuses to make a
    // second.
    const two = {
      ...oneWallet,
      balances: [...oneWallet.balances, { smartWalletId: "aaaaaaaa-0000-0000-0000-000000000000", currency: "NGN", balance: "0", error: null }],
    };
    expect(() => soleNgnWalletIndex(two, "ce91a25e-694b-4bc7-8810-349c4b912f18")).toThrow(/refusing to guess/i);
  });

  it("refuses on an empty wallet list rather than defaulting to 0", () => {
    expect(() => soleNgnWalletIndex({ ...oneWallet, balances: [] }, "ce91a25e")).toThrow(/does not list/i);
  });
});

describe("GET /v1/users/{id}/bank-accounts/deposit-accounts/NGN", () => {
  // Before the per-user virtual account is provisioned, BMONI answers 200 with
  // a POOLED house account — Bkey Limited's own, shared by every user on the
  // platform, with `bankCode` literally "XXXXXXX".
  const pooled = {
    accounts: [
      {
        id: "pooled-vba-1",
        accountName: "Bkey Limited",
        bankName: "9 Payment Service Bank",
        currency: "NGN",
        accountNumber: "6177463833",
        bankCode: "XXXXXXX",
        targetCurrency: "EUR",
      },
    ],
  };

  // Captured live: the worker's own account is issued asynchronously, so the
  // same user returns the pooled account alone for a few seconds and then both,
  // own-account-first. Position is therefore meaningless.
  const own = {
    id: "143d061f-e98d-4ce1-b933-139176963dbb",
    accountName: "Dillon Bunch",
    bankName: "PROVIDUS BANK",
    currency: "NGN",
    accountNumber: "4534076021",
    bankCode: "000023",
    targetCurrency: "NGN",
  };

  it("picks the worker's own account out of a list that also holds the pooled one", () => {
    expect(parseNgnDepositAccount({ accounts: [own, ...pooled.accounts] })).toEqual({
      id: "143d061f-e98d-4ce1-b933-139176963dbb",
      accountNumber: "4534076021",
      bankName: "PROVIDUS BANK",
      accountName: "Dillon Bunch",
    });
  });

  it("returns the name the BANK holds, which is not the profile name", () => {
    // The payments page used to show the Aide profile name here. An employer
    // doing the transfer sees their own bank's name enquiry — "Dillon Bunch" —
    // and if Aide has told them the account belongs to someone called
    // something else, the sensible thing for them to do is stop, assuming they
    // have the wrong number. Worse, the worker cannot see the screen to catch
    // it: Aide would simply be stating a name no bank agrees with.
    expect(parseNgnDepositAccount({ accounts: [own] }).accountName).toBe("Dillon Bunch");
  });

  it("still finds it when the pooled account is listed first", () => {
    // Nothing documents the ordering, so neither position may be assumed.
    expect(parseNgnDepositAccount({ accounts: [...pooled.accounts, own] }).accountNumber).toBe("4534076021");
  });

  it("refuses to hand out the pooled account as a worker's own", () => {
    // This is the most dangerous shape in the integration. It is a valid,
    // payable Nigerian account number — so Aide would read it aloud happily
    // and an employer would successfully transfer wages into a shared pool
    // with nothing tying the payment to the worker. Money would genuinely be
    // gone. Never speak an account number that is not the worker's own.
    expect(() => parseNgnDepositAccount(pooled)).toThrow(/pooled/i);
  });

  it("accepts a real per-user account", () => {
    const own = {
      accounts: [
        {
          id: "3f0a1e5c-4d2b-4a8e-9c11-7b6d5e8a2f34",
          accountName: "Aide Demo Worker",
          bankName: "9 Payment Service Bank",
          currency: "NGN",
          accountNumber: "8012345678",
          bankCode: "120001",
        },
      ],
    };
    expect(parseNgnDepositAccount(own)).toEqual({
      // Carried because onramp/vba/nigeria needs it to route deposits.
      id: "3f0a1e5c-4d2b-4a8e-9c11-7b6d5e8a2f34",
      accountNumber: "8012345678",
      bankName: "9 Payment Service Bank",
      accountName: "Aide Demo Worker",
    });
  });

  it("throws when there is no account at all", () => {
    expect(() => parseNgnDepositAccount({ accounts: [] })).toThrow(/no naira deposit account/i);
  });
});

describe("GET /v1/users/{id}/bank-accounts/nigerian-banks", () => {
  it("reads the wrapped list and its own field names", () => {
    // Wrapped in `banks`, and the fields are bankName/bankCode, not name/code.
    expect(parseBanks({ banks: [{ bankName: "WEMA BANK", bankCode: "000017" }] })).toEqual([
      { name: "WEMA BANK", code: "000017" },
    ]);
  });

  it("carries BMONI's own bank codes, which are not the NIP codes the UI uses", () => {
    // Wema is NIP 035 in the payments page and Monnify, but 000017 here.
    // Sending a NIP code to BMONI resolves to a different bank or none.
    const [wema] = parseBanks({ banks: [{ bankName: "WEMA BANK", bankCode: "000017" }] });
    expect(wema.code).not.toBe("035");
  });

  it("throws on an unwrapped array rather than silently reading no banks", () => {
    expect(() => parseBanks([{ bankName: "WEMA BANK", bankCode: "000017" }])).toThrow(/array where an object/);
  });
});

describe("POST …/bank-accounts/verify-nigerian-account", () => {
  // Captured live on 2026-09-04. The client typed this as
  // `accountHolderName`; the field is `accountName`, so name enquiry returned
  // undefined and the withdrawal flow read out an undefined account holder —
  // or registered the destination under an empty name.
  const real = {
    accountNumber: "3463455722",
    accountName: "Jabo Samson Joe",
    bankName: "PROVIDUS BANK",
    bankCode: "000023",
  };

  it("reads the holder name from accountName", () => {
    expect(parseVerifiedAccount(real)).toEqual({
      accountNumber: "3463455722",
      accountName: "Jabo Samson Joe",
      bankName: "PROVIDUS BANK",
      bankCode: "000023",
    });
  });

  it("throws rather than returning an unnamed account", () => {
    // The whole point of name enquiry is the name. Aide reads it back so the
    // payer can stop before the money moves — an empty one removes the only
    // check a blind user has on where their wages are going.
    expect(() => parseVerifiedAccount({ ...real, accountName: undefined })).toThrow(/accountName/);
  });
});
