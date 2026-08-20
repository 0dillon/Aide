import { deepseek } from "@ai-sdk/deepseek";
import { streamText } from "ai";
import { makeTools } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/system";
import { getAccount, snapshot } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

// deepseek-chat (V3) supports tool calling; deepseek-reasoner does not.
const MODEL = process.env.AIDE_MODEL ?? "deepseek-chat";

type Msg = { role: "user" | "assistant"; content: string };

// Ceiling on how long the post-stream metadata may take before the reply is
// sent without it.
const STEPS_TIMEOUT_MS = 5000;

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// Aide reads this out, so it has to mean something when heard rather than
// read. The raw provider text ("Authentication Fails, Your api key: ****0000
// is invalid") tells the user nothing about what to do next.
function spokenError(e: Error): string {
  const raw = e?.message ?? "";
  if (/authentication|api[- ]?key|401|unauthorized/i.test(raw)) {
    return "My language model rejected its API key, so I can't answer yet. The DEEPSEEK_API_KEY in the server's .env file needs a valid key.";
  }
  if (/rate.?limit|429|too many requests/i.test(raw)) {
    return "My language model is rate limited right now. Please try again in a moment.";
  }
  if (/insufficient|balance|quota|payment|402/i.test(raw)) {
    return "My language model account is out of credit, so I can't answer until it is topped up.";
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) {
    return "I couldn't reach my language model. Check the internet connection and try again.";
  }
  return raw || "Something went wrong reaching my language model.";
}

// Streams the reply as newline-delimited JSON so the browser can start
// speaking the first sentence while the rest is still generating:
//   { t: "delta", text }                        — a chunk of the reply text
//   { t: "done", navigateTo?, newUserId?, state } — final metadata
//   { t: "error", message }                     — something broke mid-stream
// Cookies can't be set once streaming has begun, so on account switches the
// client receives `newUserId` and signs in via POST /api/account/switch.
export async function POST(req: Request) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json({ error: "DEEPSEEK_API_KEY is not set. Add it to .env to enable Aide." }, { status: 500 });
  }

  let messages: Msg[];
  try {
    const body = (await req.json()) as { messages: Msg[] };
    messages = body.messages;
  } catch (e) {
    return Response.json({ error: "invalid json payload" }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  const account = await getAccount(userIdFrom(req));

  // streamText does NOT throw when the model call fails. It reports the error
  // here, ends textStream without emitting anything, and leaves result.steps
  // permanently unsettled — so the `catch` below never fires and the response
  // is never closed. That turned any upstream failure (rejected key, rate
  // limit, no credit) into a connection that streamed nothing forever, which
  // the browser renders as "Aide is thinking" with no way out. To a user who
  // cannot see that, endless silence is indistinguishable from a dead app, so
  // the failure has to be captured and spoken.
  const failure: { error: Error | null } = { error: null };
  // Aide's durable memory, restated on every turn. Cheaper and far more
  // reliable than making the model call a tool to find out what it knows —
  // and since the transcript is no longer persisted anywhere, this is the
  // only thing carrying context in from an earlier session.
  const saved = account.preferences ?? [];
  const memory =
    saved.length > 0
      ? `\n- Things ${account.name} has asked you to remember: ${saved.map((p) => `"${p}"`).join("; ")}.`
      : "\n- You have nothing saved about this user yet.";

  const result = streamText({
    model: deepseek(MODEL),
    system: `${SYSTEM_PROMPT}\n- The current user is ${account.name}, signed in with a ${account.role} account.${memory}`,
    messages,
    tools: makeTools(account),
    maxSteps: 6,
    onError: ({ error }) => {
      failure.error = error instanceof Error ? error : new Error(String(error));
      console.error("[agent] model call failed:", failure.error.message);
    },
  });

  const encoder = new TextEncoder();
  const emit = (controller: ReadableStreamDefaultController, obj: unknown) =>
    controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const text of result.textStream) {
          if (text) emit(controller, { t: "delta", text });
        }
        // An empty stream means failure, not a short reply — see above.
        if (failure.error) throw failure.error;

        // result.steps is also left unsettled by a half-failed call, so it is
        // raced against a deadline. Losing the navigation hint degrades the
        // reply; never closing the response breaks Aide outright.
        const steps = await withDeadline(result.steps, STEPS_TIMEOUT_MS, []);
        const toolResults = steps.flatMap(
          (s) =>
            s.toolResults as {
              toolName: string;
              result?: { page?: string; section?: string; userId?: string; jobId?: string; ok?: boolean; filters?: Record<string, unknown> };
            }[],
        );

        // If the model opened a screen (or filtered jobs, or started an
        // assessment), tell the browser where to route.
        const routes: Record<string, string> = { home: "/", jobs: "/jobs", payments: "/payments", profile: "/profile", signup: "/signup" };
        let navigateTo: string | undefined;
        const opened = toolResults.find((t) => t.toolName === "open_page")?.result;
        if (opened?.page) navigateTo = routes[opened.page] + (opened.section ? `#${opened.section}` : "");
        const started = toolResults.find((t) => t.toolName === "start_assessment")?.result;
        if (started?.ok && started.jobId) navigateTo = `/jobs?assessment=${started.jobId}`;
        const filtered = toolResults.find((t) => t.toolName === "filter_jobs")?.result;
        if (filtered?.ok) {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(filtered.filters ?? {})) {
            if (v !== undefined && v !== null) params.set(k, String(v));
          }
          navigateTo = `/jobs?${params.toString()}#listings`;
        }

        // If the model created or switched to an account, the client signs
        // this browser in via /api/account/switch.
        const newUserId = toolResults.find(
          (t) => (t.toolName === "create_account" || t.toolName === "switch_account") && t.result?.userId,
        )?.result?.userId;

        // Logout: cookies can't be cleared mid-stream, so the client calls
        // POST /api/auth/logout and restarts when it sees this flag.
        const loggedOut = !!toolResults.find((t) => t.toolName === "log_out" && t.result?.ok);

        emit(controller, { t: "done", navigateTo, newUserId, loggedOut, state: await snapshot(account.id) });
      } catch (e) {
        emit(controller, { t: "error", message: spokenError(e as Error) });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
