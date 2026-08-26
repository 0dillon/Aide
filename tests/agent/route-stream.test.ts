import { describe, expect, it, vi } from "vitest";

// The agent route is Aide's voice. Its one non-negotiable duty is to ALWAYS
// finish: emit something and close. A route that hangs shows the user "Aide is
// thinking" forever, and a user who cannot see the screen has no way to tell
// that apart from an app that has died. This exact failure shipped — the SDK
// reports a failed call through onError, ends the text stream without throwing,
// and leaves result.steps permanently unsettled.

// The route refuses to call the model at all without a key, and nothing in
// this file loads lib/env (which is what normally pulls in dotenv), so the key
// has to be planted before the route module is imported.
vi.hoisted(() => {
  process.env.DEEPSEEK_API_KEY = "sk-test-key-never-used-the-model-is-mocked";
});

const model = vi.hoisted(() => ({ impl: (_opts: any): any => ({}) }));

vi.mock("ai", () => ({ streamText: (opts: any) => model.impl(opts) }));
vi.mock("@ai-sdk/deepseek", () => ({ deepseek: () => ({ id: "fake-model" }) }));
vi.mock("@/lib/agent/tools", () => ({ makeTools: () => ({}) }));
vi.mock("@/lib/store", () => ({
  getAccount: async () => ({
    id: "demo-worker", name: "Ada", role: "worker", skills: [], bio: "",
    preferences: ["I can only work mornings"], createdAt: 1,
  }),
  snapshot: async () => ({ applications: [], jobs: [] }),
}));

const { POST } = await import("../../app/api/agent/route");

// The route reads fullStream, not textStream: tool results arrive there the
// moment the tool returns, which is the only point early enough to move the
// screen while Aide is still saying it is moving.
const streamOf = (text: string[], steps: any, midStreamTools: { toolName: string; result: any }[] = []) => ({
  fullStream: (async function* () {
    for (const t of text) yield { type: "text-delta", textDelta: t };
    for (const tr of midStreamTools) yield { type: "tool-result", ...tr };
  })(),
  steps,
});

const ask = (body: unknown = { messages: [{ role: "user", content: "find me work" }] }) =>
  POST(new Request("http://localhost/api/agent", { method: "POST", body: JSON.stringify(body) }));

// Drain the NDJSON body, refusing to wait forever — the point of these tests.
async function drain(res: Response, ms = 8000) {
  const events: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
  for (;;) {
    const step = await Promise.race([reader.read(), deadline]);
    if (step === "timeout") return { events, timedOut: true };
    const { value, done } = step as ReadableStreamReadResult<Uint8Array>;
    if (value) {
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) events.push(JSON.parse(line));
      }
    }
    if (done) break;
  }
  return { events, timedOut: false };
}

describe("the stream always terminates", () => {
  it("reports a failed model call instead of hanging forever", async () => {
    // Exactly the shipped bug: onError fires, no text is produced, and steps
    // never settles. The route must not wait on it.
    model.impl = (opts) => {
      queueMicrotask(() => opts.onError?.({ error: new Error("Authentication Fails, api key invalid") }));
      return streamOf([], new Promise(() => {}));
    };
    const { events, timedOut } = await drain(await ask());
    expect(timedOut, "route hung instead of closing").toBe(false);
    expect(events.at(-1)?.t).toBe("error");
  });

  it("closes even when the metadata never resolves after a good reply", async () => {
    // A half-failed call can leave steps unsettled while text did arrive. The
    // reply is worth more than the navigation hint, so it must still be sent.
    model.impl = () => streamOf(["Your balance is ready."], new Promise(() => {}));
    const { events, timedOut } = await drain(await ask(), 9000);
    expect(timedOut, "route hung instead of closing").toBe(false);
    expect(events.some((e) => e.t === "delta")).toBe(true);
    expect(events.at(-1)?.t).toBe("done");
  }, 15000);

  it("reports a thrown error rather than dying silently", async () => {
    model.impl = () => ({
      fullStream: (async function* () {
        yield { type: "text-delta", textDelta: "starting" };
        throw new Error("connection reset");
      })(),
      steps: Promise.resolve([]),
    });
    const { events, timedOut } = await drain(await ask());
    expect(timedOut).toBe(false);
    expect(events.at(-1)?.t).toBe("error");
  });
});

describe("spoken error messages", () => {
  const failWith = async (message: string) => {
    model.impl = (opts) => {
      queueMicrotask(() => opts.onError?.({ error: new Error(message) }));
      return streamOf([], new Promise(() => {}));
    };
    const { events } = await drain(await ask());
    return events.at(-1)?.message as string;
  };

  it("explains a rejected API key in words worth hearing", async () => {
    expect(await failWith("Authentication Fails, Your api key: ****0000 is invalid")).toMatch(/api key/i);
  });

  it("explains rate limiting as something to retry", async () => {
    expect(await failWith("429 Too Many Requests")).toMatch(/try again/i);
  });

  it("explains an exhausted account", async () => {
    expect(await failWith("402 insufficient balance")).toMatch(/credit/i);
  });

  it("explains a network failure as a connection problem", async () => {
    expect(await failWith("fetch failed")).toMatch(/connection|reach/i);
  });
});

describe("streaming a normal reply", () => {
  it("emits each chunk as a delta and finishes with done", async () => {
    model.impl = () => streamOf(["Let me check. ", "You have twelve thousand naira."], Promise.resolve([]));
    const { events } = await drain(await ask());
    expect(events.filter((e) => e.t === "delta").map((e) => e.text)).toEqual([
      "Let me check. ",
      "You have twelve thousand naira.",
    ]);
    expect(events.at(-1)?.t).toBe("done");
  });

  it("gives the model the user's saved preferences on every turn", async () => {
    // This is Aide's only memory now that the transcript is not persisted.
    let captured = "";
    model.impl = (opts) => {
      captured = opts.system;
      return streamOf(["ok"], Promise.resolve([]));
    };
    await drain(await ask());
    expect(captured).toContain("I can only work mornings");
  });

  it("tells the browser which page to open", async () => {
    model.impl = () =>
      streamOf(["Opening that."], Promise.resolve([
        { toolResults: [{ toolName: "open_page", result: { ok: true, page: "payments", section: "balance" } }] },
      ]));
    const { events } = await drain(await ask());
    expect(events.at(-1)?.navigateTo).toBe("/payments#balance");
  });

  it("opens the right message thread when Aide reads one aloud", async () => {
    // The threads are collapsed by default, so without this Aide narrates a
    // conversation the user cannot see.
    model.impl = () =>
      streamOf(["Here are your messages."], Promise.resolve([
        { toolResults: [{ toolName: "read_messages", result: { ok: true, jobId: "g-abc" } }] },
      ]));
    const { events } = await drain(await ask());
    expect(events.at(-1)?.navigateTo).toContain("thread=g-abc");
  });

  it("signals a logout so the browser can clear its cookies", async () => {
    model.impl = () =>
      streamOf(["Signing you out."], Promise.resolve([
        { toolResults: [{ toolName: "log_out", result: { ok: true } }] },
      ]));
    const { events } = await drain(await ask());
    expect(events.at(-1)?.loggedOut).toBe(true);
  });
});

describe("request validation", () => {
  it("rejects a malformed body without invoking the model", async () => {
    let called = false;
    model.impl = () => { called = true; return streamOf([], Promise.resolve([])); };
    const res = await POST(new Request("http://localhost/api/agent", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("rejects an empty conversation", async () => {
    expect((await ask({ messages: [] })).status).toBe(400);
  });

  it("rejects a missing messages field", async () => {
    expect((await ask({})).status).toBe(400);
  });
});

describe("moving the screen while Aide is still speaking", () => {
  // Aide announces the page as it streams, sentence by sentence. Navigation
  // used to be sent only in the final `done` event — after the rest of the
  // text, after the steps deadline, after a snapshot — so Aide said "you are
  // on the jobs page" seconds before the screen moved. Someone who cannot see
  // the screen has no way to catch that; to them Aide simply lied.
  const navEvents = (events: any[]) => events.filter((e) => e.t === "nav");

  it("sends the destination as soon as the tool returns", async () => {
    model.impl = () =>
      streamOf(["Opening your payments now."], Promise.resolve([]), [
        { toolName: "open_page", result: { ok: true, page: "payments", section: "balance" } },
      ]);
    const { events } = await drain(await ask());
    expect(navEvents(events)[0]?.navigateTo).toBe("/payments#balance");
  });

  it("sends it before the reply has finished", async () => {
    // The whole point: the nav event must not be last.
    model.impl = () =>
      streamOf(["Opening that."], Promise.resolve([]), [
        { toolName: "open_page", result: { ok: true, page: "jobs" } },
      ]);
    const { events } = await drain(await ask());
    const navAt = events.findIndex((e) => e.t === "nav");
    const doneAt = events.findIndex((e) => e.t === "done");
    expect(navAt).toBeGreaterThan(-1);
    expect(navAt).toBeLessThan(doneAt);
  });

  it("still finds the destination when only the finished steps carry it", async () => {
    // Belt and braces: a tool result that never reached the stream.
    model.impl = () =>
      streamOf(["Opening that."], Promise.resolve([
        { toolResults: [{ toolName: "open_page", result: { ok: true, page: "profile" } }] },
      ]));
    const { events } = await drain(await ask());
    expect(events.at(-1)?.navigateTo).toBe("/profile");
  });

  it("routes an assessment to the panel that runs it", async () => {
    model.impl = () =>
      streamOf(["Starting your assessment."], Promise.resolve([]), [
        { toolName: "start_assessment", result: { ok: true, jobId: "g-1" } },
      ]);
    const { events } = await drain(await ask());
    expect(navEvents(events)[0]?.navigateTo).toBe("/jobs?assessment=g-1");
  });

  it("does not move the screen for a tool that went nowhere", async () => {
    model.impl = () =>
      streamOf(["Your balance is twelve thousand naira."], Promise.resolve([]), [
        { toolName: "get_balance", result: { ok: true, balance: 12000 } },
      ]);
    const { events } = await drain(await ask());
    expect(navEvents(events)).toHaveLength(0);
    expect(events.at(-1)?.navigateTo).toBeUndefined();
  });
});

describe("a failure that carries no message", () => {
  // The live site hit exactly this: the model call failed with an error whose
  // `.message` was empty, so every branch fell through to the generic line AND
  // the server log printed an empty string. Nobody — user or developer — was
  // left with anything to act on.
  const failWithValue = async (thrown: unknown) => {
    model.impl = (opts) => {
      queueMicrotask(() => opts.onError?.({ error: thrown }));
      return streamOf([], new Promise(() => {}));
    };
    const { events } = await drain(await ask());
    return events.at(-1);
  };

  it("still says something, rather than an empty sentence", async () => {
    const ev = await failWithValue(new Error(""));
    expect(ev?.t).toBe("error");
    expect(String(ev?.message).trim().length).toBeGreaterThan(20);
  });

  it("finds the reason on cause when message is empty", async () => {
    // The SDK wraps provider failures; the useful part is often underneath.
    const wrapped = new Error("");
    (wrapped as { cause?: unknown }).cause = new Error("401 Authentication Fails");
    const ev = await failWithValue(wrapped);
    expect(ev?.message).toMatch(/api key/i);
  });

  it("finds it on a status code too", async () => {
    const e = Object.assign(new Error(""), { statusCode: 429 });
    expect((await failWithValue(e))?.message).toMatch(/try again/i);
  });

  it("never reads an object dump aloud", async () => {
    const ev = await failWithValue({ weird: true });
    expect(ev?.message).not.toMatch(/\[object|\{|\}/);
  });
});
