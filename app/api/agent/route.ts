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

  const { messages } = (await req.json()) as { messages: Msg[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  const account = getAccount(userIdFrom(req));
  const result = streamText({
    model: deepseek(MODEL),
    system: `${SYSTEM_PROMPT}\n- The current user is ${account.name}, signed in with a ${account.role} account.`,
    messages,
    tools: makeTools(account),
    maxSteps: 6,
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

        const steps = await result.steps;
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

        emit(controller, { t: "done", navigateTo, newUserId, state: snapshot(account.id) });
      } catch (e) {
        emit(controller, { t: "error", message: (e as Error).message });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
