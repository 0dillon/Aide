import { beforeEach, describe, expect, it, vi } from "vitest";

// The screen path is a SECOND way into the same actions, with its own
// authorization checks. Someone can curl these routes directly, so the guards
// on Aide's tools protect nothing here — these have to hold on their own.

const store = vi.hoisted(() => ({
  getAccount: vi.fn(), getJob: vi.fn(), getWorker: vi.fn(),
  hireWorker: vi.fn(), rejectWorker: vi.fn(), payWorker: vi.fn(),
  verifyPaymentCoverage: vi.fn(), publishEvent: vi.fn(),
  listMessages: vi.fn(), sendMessage: vi.fn(), messagingUnlocked: vi.fn(),
}));
const session = vi.hoisted(() => ({ userIdFrom: vi.fn(() => "whoever") }));

vi.mock("@/lib/store", () => store);
vi.mock("@/lib/session", () => session);

const status = await import("../../app/api/jobs/status/route");
const messages = await import("../../app/api/messages/route");

const EMPLOYER = { id: "u-emp", name: "ClearVoice Media", role: "employer", skills: [], bio: "", createdAt: 1 };
const WORKER = { id: "demo-worker", name: "Ada Okafor", role: "worker", skills: [], bio: "", createdAt: 1 };
const OWN_GIG = { id: "g-own", title: "Own gig", task: "t", skill: "s", pay: 12000, employer: "ClearVoice Media", requiresAssessment: false };
const OTHER_GIG = { id: "g-other", title: "Rival gig", task: "t", skill: "s", pay: 5000, employer: "Rival Media", requiresAssessment: false };

const post = (mod: any, body: unknown) =>
  mod.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  store.getWorker.mockReturnValue({ id: "demo-worker", name: "Ada Okafor" });
  store.getJob.mockImplementation(async (id: string) =>
    id === "g-own" ? OWN_GIG : id === "g-other" ? OTHER_GIG : undefined,
  );
  store.messagingUnlocked.mockResolvedValue(true);
});

describe("POST /api/jobs/status", () => {
  it("refuses a worker trying to hire themselves", async () => {
    store.getAccount.mockResolvedValue(WORKER);
    const res = await post(status, { jobId: "g-own", action: "hire" });
    expect(res.status).toBe(403);
    expect(store.hireWorker).not.toHaveBeenCalled();
  });

  it("refuses an employer acting on a rival's gig", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    const res = await post(status, { jobId: "g-other", action: "hire" });
    expect(res.status).toBe(403);
    expect(store.hireWorker).not.toHaveBeenCalled();
  });

  it("refuses a gig that does not exist", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    expect((await post(status, { jobId: "ghost", action: "hire" })).status).toBe(403);
  });

  it("requires both a job and an action", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    expect((await post(status, { jobId: "g-own" })).status).toBe(400);
    expect((await post(status, { action: "hire" })).status).toBe(400);
  });

  it("lets the owning employer hire, and tells the worker out loud", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    store.hireWorker.mockResolvedValue({ id: "a1", jobId: "g-own", status: "hired", verified: true });
    const res = await post(status, { jobId: "g-own", action: "hire" });
    expect(res.status).toBe(200);
    // Being hired is news the worker cannot see on screen — it must be spoken.
    expect(store.publishEvent).toHaveBeenCalled();
    expect(JSON.stringify(store.publishEvent.mock.calls[0])).toMatch(/hired/i);
  });

  it("refuses to mark a gig paid without a confirmed payment", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    store.verifyPaymentCoverage.mockResolvedValue({ ok: false, message: "no payment" });
    const res = await post(status, { jobId: "g-own", action: "pay" });
    expect(res.status).toBe(409);
    expect(store.payWorker).not.toHaveBeenCalled();
  });

  it("marks it paid once the money is confirmed", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    store.verifyPaymentCoverage.mockResolvedValue({ ok: true, message: "covered" });
    store.payWorker.mockResolvedValue({ id: "a1", jobId: "g-own", status: "paid", verified: true });
    expect((await post(status, { jobId: "g-own", action: "pay" })).status).toBe(200);
  });

  it("notifies the worker kindly when declined", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    store.rejectWorker.mockResolvedValue({ id: "a1", jobId: "g-own", status: "rejected", verified: true });
    await post(status, { jobId: "g-own", action: "reject" });
    expect(store.publishEvent).toHaveBeenCalled();
  });
});

describe("/api/messages", () => {
  const get = (jobId: string) =>
    messages.GET(new Request(`http://localhost/api/messages?jobId=${jobId}`));

  it("refuses to show a thread on a gig the employer does not own", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    const res = await get("g-other");
    expect(res.status).toBe(403);
    expect(store.listMessages).not.toHaveBeenCalled();
  });

  it("requires a jobId", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    expect((await messages.GET(new Request("http://localhost/api/messages"))).status).toBe(400);
  });

  it("returns 404 for a gig that does not exist", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    expect((await get("ghost")).status).toBe(404);
  });

  it("hides the thread until the worker is hired", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    store.messagingUnlocked.mockResolvedValue(false);
    const res = await get("g-own");
    const body = await res.json();
    expect(body.unlocked).toBe(false);
    expect(body.messages).toEqual([]);
  });

  it("refuses to post into a rival's thread", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    const res = await post(messages, { jobId: "g-other", text: "hello" });
    expect(res.status).toBe(403);
    expect(store.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to post before the hire", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    store.messagingUnlocked.mockResolvedValue(false);
    const res = await post(messages, { jobId: "g-own", text: "hello" });
    expect(res.status).toBe(409);
    expect(store.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    store.getAccount.mockResolvedValue(EMPLOYER);
    expect((await post(messages, { jobId: "g-own", text: "   " })).status).toBe(400);
  });

  it("bounds message length", async () => {
    // Aide reads these aloud; an unbounded message is also an unbounded
    // synthesis job and an unbounded thing to sit through.
    store.getAccount.mockResolvedValue(EMPLOYER);
    const res = await post(messages, { jobId: "g-own", text: "x".repeat(2001) });
    expect(res.status).toBe(400);
    expect(store.sendMessage).not.toHaveBeenCalled();
  });

  it("records which side sent it, so the thread reads correctly", async () => {
    store.getAccount.mockResolvedValue(WORKER);
    store.sendMessage.mockResolvedValue({ id: "m1" });
    await post(messages, { jobId: "g-own", text: "When do I start?" });
    expect(store.sendMessage).toHaveBeenCalledWith("g-own", "worker", "Ada Okafor", "When do I start?");
  });
});
