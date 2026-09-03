import { beforeEach, describe, expect, it, vi } from "vitest";

// The transport rule, and why it is not symmetric.
//
// BMONI has no idempotency keys anywhere. A read that gives up costs one more
// request. A transfer that gives up costs a worker their wages — or pays them
// twice, which is the same money gone from someone else. So reads may time out
// and retry; money-moving calls may do neither.
//
// The subtle half is that aborting a slow transfer does not cancel it. The
// server carries on; all the abort destroys is our record of having asked. That
// is how a "failed" withdrawal becomes a second one.

let client: typeof import("../../lib/banking/bmoni-client");
let fetchMock: ReturnType<typeof vi.fn>;

const ok = (data: unknown) =>
  ({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data })) }) as any;
const fail = (status: number, body: unknown) =>
  ({ ok: false, status, text: () => Promise.resolve(JSON.stringify(body)) }) as any;

beforeEach(async () => {
  vi.resetModules();
  process.env.BMONI_API_KEY = "pk_test_key";
  process.env.BMONI_BASE_URL = "https://embedded-dev.bmoni.test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  client = await import("../../lib/banking/bmoni-client");
});

describe("authentication and shape", () => {
  it("sends the partner key as x-api-key on every call", async () => {
    fetchMock.mockResolvedValue(ok({ id: "u1" }));
    await client.bmoniRead({ path: "/v1/users/u1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://embedded-dev.bmoni.test/v1/users/u1");
    expect(init.headers["x-api-key"]).toBe("pk_test_key");
  });

  it("unwraps the data envelope", async () => {
    fetchMock.mockResolvedValue(ok({ bmoniUserId: "u1" }));
    expect(await client.bmoniRead({ path: "/x" })).toEqual({ bmoniUserId: "u1" });
  });

  it("refuses to run without an API key rather than calling unauthenticated", async () => {
    vi.resetModules();
    delete process.env.BMONI_API_KEY;
    const bare = await import("../../lib/banking/bmoni-client");
    await expect(bare.bmoniRead({ path: "/x" })).rejects.toThrow(/BMONI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("error reporting", () => {
  it("joins the array form so every field fault arrives at once", async () => {
    fetchMock.mockResolvedValue(
      fail(400, { message: ["phoneNumber must be a valid phone number", "email must be an email"], error: "Bad Request" }),
    );
    await expect(client.bmoniRead({ path: "/v1/users", method: "POST", body: {} })).rejects.toThrow(
      /phoneNumber must be a valid phone number; email must be an email/,
    );
  });

  it("marks a 409 as recoverable, since it means an earlier attempt landed", async () => {
    fetchMock.mockResolvedValue(fail(409, { message: "User already exists with this email" }));
    await expect(client.bmoniRead({ path: "/v1/users", method: "POST", body: {} })).rejects.toMatchObject({
      isConflict: true,
    });
  });

  it("treats a 500 carrying a signature fault as OUR bug, not a transient one", async () => {
    // These never succeed on retry. Mistaking one for a flaky server is how a
    // broken signature gets submitted again and again.
    fetchMock.mockResolvedValue(fail(500, { message: "Invalid yParityOrV" }));
    await expect(client.bmoniMove({ path: "/sign", method: "POST", body: {} })).rejects.toMatchObject({
      isClientFault: true,
    });
  });

  it("does not guess at an unreadable body", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve("<html>gateway</html>") } as any);
    await expect(client.bmoniMove({ path: "/x", method: "POST" })).rejects.toThrow(/unreadable response body/);
  });
});

describe("reads may retry", () => {
  it("retries a transport failure and succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue(ok({ balance: "1.00" }));
    expect(await client.bmoniRead({ path: "/balances" })).toEqual({ balance: "1.00" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry an answer the server actually gave", async () => {
    // A 404 will still be a 404. Repeating it just delays telling the user.
    fetchMock.mockResolvedValue(fail(404, { message: "User not found" }));
    await expect(client.bmoniRead({ path: "/v1/users/nope" })).rejects.toThrow(/User not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal, so a hung read cannot wedge the request", async () => {
    fetchMock.mockResolvedValue(ok({}));
    await client.bmoniRead({ path: "/x" });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("money-moving calls may not", () => {
  it("NEVER retries — one attempt, then the error surfaces", async () => {
    // The whole rule. A retried transfer is a worker paid twice.
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(client.bmoniMove({ path: "/offramp", method: "POST", body: {} })).rejects.toThrow("ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("NEVER aborts early — no timeout signal is attached", async () => {
    // Aborting does not cancel what the server is doing. It only destroys our
    // record of having asked, which is how wages go missing.
    fetchMock.mockResolvedValue(ok({ proposalId: "p1" }));
    await client.bmoniMove({ path: "/offramp", method: "POST", body: {} });
    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined();
  });
});
