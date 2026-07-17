import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { tools } from "@/lib/agent/tools";
import { SYSTEM_PROMPT } from "@/lib/agent/system";
import { snapshot } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.AIDE_MODEL ?? "claude-sonnet-5";

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set. Add it to .env to enable Aide." }, { status: 500 });
  }

  const { messages } = (await req.json()) as { messages: Msg[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  try {
    const result = await generateText({
      model: anthropic(MODEL),
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
