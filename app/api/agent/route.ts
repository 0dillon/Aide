import { deepseek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { makeTools } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/system";
import { getAccount, snapshot } from "@/lib/store";
import { userCookie, userIdFrom } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

// deepseek-chat (V3) supports tool calling; deepseek-reasoner does not.
const MODEL = process.env.AIDE_MODEL ?? "deepseek-chat";

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json({ error: "DEEPSEEK_API_KEY is not set. Add it to .env to enable Aide." }, { status: 500 });
  }

  const { messages } = (await req.json()) as { messages: Msg[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  try {
    const account = getAccount(userIdFrom(req));
    const result = await generateText({
      model: deepseek(MODEL),
      system: `${SYSTEM_PROMPT}\n- The current user is ${account.name}, signed in with a ${account.role} account.`,
      messages,
      tools: makeTools(account),
      maxSteps: 6,
    });

    const toolResults = result.steps.flatMap(
      (s) => s.toolResults as { toolName: string; result?: { page?: string; userId?: string } }[],
    );

    // If the model opened a screen, tell the browser where to route.
    const page = toolResults.find((t) => t.toolName === "open_page")?.result?.page;
    const routes: Record<string, string> = { home: "/", jobs: "/jobs", payments: "/payments", profile: "/profile", signup: "/signup" };
    const navigateTo = page ? routes[page] : undefined;

    // If the model created an account, sign this browser in.
    const newUserId = toolResults.find((t) => t.toolName === "create_account")?.result?.userId;
    const headers = newUserId ? { "Set-Cookie": userCookie(newUserId) } : undefined;

    return Response.json({ reply: result.text, state: snapshot(), navigateTo }, { headers });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
