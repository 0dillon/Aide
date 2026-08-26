import { streamText } from "ai";
import { aideModel, usingFallbackProvider } from "@/lib/agent/model";
import { makeTools } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/system";
import { getAccount, snapshot } from "@/lib/store";
import { userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;


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
    return "My language model rejected its API key, so I can't answer yet. The server needs a valid key.";
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
  // AbortSignal.timeout throws a DOMException reading "The operation was
  // aborted due to timeout". It matches none of the patterns above, so it used
  // to fall through and get read aloud in those words.
  if (/abort|timed? ?out|UND_ERR_CONNECT_TIMEOUT|deadline/i.test(raw)) {
    return "My language model took too long to answer. Give me a moment and try again.";
  }
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded/i.test(raw)) {
    return "My language model is having trouble at its end right now. Give me a moment and try again.";
  }
  // Never return `raw`. Anything unrecognised is provider or runtime text that
  // means nothing when heard, and this string is spoken.
  return "Something went wrong reaching my language model. Try again in a moment.";
}

// Where a tool result should send the screen, if anywhere. One place, used
// both mid-stream (as each tool returns) and again at the end as a fallback,
// so the two can never disagree about where "there" is.
type ToolResult = {
  page?: string;
  section?: string;
  jobId?: string;
  ok?: boolean;
  filters?: Record<string, unknown>;
} | undefined;

const PAGE_ROUTES: Record<string, string> = {
  home: "/",
  jobs: "/jobs",
  payments: "/payments",
  profile: "/profile",
  signup: "/signup",
};

function routeFor(toolName: string, result: ToolResult): string | undefined {
  if (!result) return undefined;
  if (toolName === "open_page" && result.page) {
    return PAGE_ROUTES[result.page] + (result.section ? `#${result.section}` : "");
  }
  // Reading or sending a message opens that gig's thread on screen — the
  // threads sit collapsed, so without this Aide narrates a conversation the
  // user cannot see.
  if ((toolName === "read_messages" || toolName === "send_message") && result.ok && result.jobId) {
    return `/jobs?thread=${result.jobId}#onboarding`;
  }
  if (toolName === "start_assessment" && result.ok && result.jobId) {
    return `/jobs?assessment=${result.jobId}`;
  }
  if (toolName === "filter_jobs" && result.ok) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(result.filters ?? {})) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    return `/jobs?${params.toString()}#listings`;
  }
  return undefined;
}

// Streams the reply as newline-delimited JSON so the browser can start
// speaking the first sentence while the rest is still generating:
//   { t: "delta", text }                        — a chunk of the reply text
//   { t: "nav", navigateTo }                     — move the screen, mid-reply
//   { t: "done", navigateTo?, newUserId?, state } — final metadata
//   { t: "error", message }                     — something broke mid-stream
// Cookies can't be set once streaming has begun, so on account switches the
// client receives `newUserId` and signs in via POST /api/account/switch.
export async function POST(req: Request) {
  // Either the default DeepSeek key, or a fully-configured OpenAI-compatible
  // provider. Gating on DEEPSEEK_API_KEY alone locked out the fallback that
  // exists precisely for when that key is dead or out of credit.
  if (!process.env.DEEPSEEK_API_KEY && !usingFallbackProvider()) {
    return Response.json(
      { error: "No language model is configured. Set DEEPSEEK_API_KEY, or AIDE_OPENAI_BASE_URL with AIDE_API_KEY." },
      { status: 500 },
    );
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
    model: aideModel(),
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

  // Where a turn's time actually goes. Aide feeling slow is a bug report with
  // no detail in it — the model, the tool calls, the steps deadline and the
  // snapshot are four different waits and they need telling apart.
  const t0 = Date.now();
  let firstTokenAt = 0;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Read the FULL stream, not just the text. Tool results arrive here the
        // instant the tool returns, while the model is still writing the
        // sentence about it — which is the only moment early enough to be
        // useful. Waiting for the end of the stream meant Aide said "you're on
        // the jobs page" and the screen moved several seconds later, after the
        // remaining text, the steps deadline and a snapshot. To someone who
        // cannot see the screen, that is indistinguishable from Aide lying
        // about where they are.
        let navigateTo: string | undefined;
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            if (part.textDelta) {
              if (!firstTokenAt) firstTokenAt = Date.now();
              emit(controller, { t: "delta", text: part.textDelta });
            }
          } else if (part.type === "tool-result") {
            const to = routeFor(part.toolName, part.result as ToolResult);
            if (to) {
              navigateTo = to;
              emit(controller, { t: "nav", navigateTo: to });
            }
          }
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

        // Belt and braces: if a tool result somehow never reached the stream
        // above, recover the destination from the finished steps. The client
        // ignores a repeat of somewhere it has already gone.
        if (!navigateTo) {
          for (const t of toolResults) {
            const to = routeFor(t.toolName, t.result as ToolResult);
            if (to) navigateTo = to;
          }
        }

        // If the model created or switched to an account, the client signs
        // this browser in via /api/account/switch.
        const newUserId = toolResults.find(
          (t) => (t.toolName === "create_account" || t.toolName === "switch_account") && t.result?.userId,
        )?.result?.userId;

        // Logout: cookies can't be cleared mid-stream, so the client calls
        // POST /api/auth/logout and restarts when it sees this flag.
        const loggedOut = !!toolResults.find((t) => t.toolName === "log_out" && t.result?.ok);

        const streamedAt = Date.now();
        const state = await snapshot(account.id);
        const doneAt = Date.now();
        // One line per turn. The gap between first token and end of stream is
        // the model; the gap after it is ours.
        console.log(
          `[agent] first token ${firstTokenAt ? firstTokenAt - t0 : -1}ms · stream ${streamedAt - t0}ms · ` +
            `snapshot ${doneAt - streamedAt}ms · total ${doneAt - t0}ms`,
        );
        emit(controller, { t: "done", navigateTo, newUserId, loggedOut, state });
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
