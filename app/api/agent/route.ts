import { deepseek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { tools } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/system";
import { snapshot } from "@/lib/store";

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
    const result = await generateText({
      model: deepseek(MODEL),
      system: SYSTEM_PROMPT,
      messages,
      tools,
      maxSteps: 6,
    });

    return Response.json({ reply: result.text, state: snapshot() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
