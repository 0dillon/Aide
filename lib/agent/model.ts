import { deepseek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// deepseek-chat (V3) supports tool calling; deepseek-reasoner does not. Aide is
// tool-driven end to end, so whatever this points at MUST support tool calling.
export const MODEL_ID = process.env.AIDE_MODEL ?? "deepseek-chat";

// Escape hatch. DeepSeek is the default, but a dead key or an empty balance
// should not be able to take the whole product down: every provider worth using
// speaks the OpenAI wire format, so pointing Aide at another one is three
// environment variables and no code change.
//
//   AIDE_OPENAI_BASE_URL=https://api.groq.com/openai/v1
//   AIDE_API_KEY=...
//   AIDE_MODEL=llama-3.3-70b-versatile
//
// Both the URL and the key must be present, otherwise we stay on DeepSeek
// rather than half-configuring a provider that will fail at the first request.
const BASE_URL = process.env.AIDE_OPENAI_BASE_URL?.trim();
const API_KEY = process.env.AIDE_API_KEY?.trim();

export function usingFallbackProvider(): boolean {
  return !!(BASE_URL && API_KEY);
}

export function aideModel() {
  if (BASE_URL && API_KEY) {
    const provider = createOpenAICompatible({
      name: "aide-llm",
      baseURL: BASE_URL,
      apiKey: API_KEY,
    });
    return provider(MODEL_ID);
  }
  return deepseek(MODEL_ID);
}
