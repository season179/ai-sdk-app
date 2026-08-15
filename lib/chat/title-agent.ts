import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

const TITLE_SYSTEM_PROMPT =
  "Return only a 3-5 word title for this conversation. No quotes, no punctuation, no trailing period.";

const MAX_TITLE_CHARS = 60;
const MAX_SOURCE_CHARS = 2000;

export type GenerateSessionTitleInput = {
  firstUserText: string;
  firstAssistantText: string;
};

/**
 * Names a chat session. Deliberately isolated from the chat agent so it can be
 * tuned or swapped without touching the chat route or data layer: its own model
 * env (OPENROUTER_TITLE_MODEL, falling back to OPENROUTER_DEFAULT_MODEL), its own
 * prompt, and its own limits. A single generateText call (no tool loop is
 * needed) and fully fail-soft — returns null on any problem so the caller never
 * blocks on or fails because of titling.
 */
export async function generateSessionTitle({
  firstUserText,
  firstAssistantText,
}: GenerateSessionTitleInput): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = (
    process.env.OPENROUTER_TITLE_MODEL ?? process.env.OPENROUTER_DEFAULT_MODEL
  )?.trim();

  if (!apiKey || !model) {
    return null;
  }

  // Nothing to name (e.g. a tool-only first turn with no visible text) — don't
  // spend a model call prompting on empty strings.
  if (!firstUserText.trim() && !firstAssistantText.trim()) {
    return null;
  }

  try {
    const openrouter = createOpenRouter({ apiKey });
    const { text } = await generateText({
      // Reasoning models would spend the whole maxOutputTokens budget thinking
      // and return an empty title; OpenRouter translates this off-switch for
      // whichever model is configured.
      model: openrouter.chat(model, {
        reasoning: { enabled: false, effort: "none", exclude: true },
      }),
      instructions: TITLE_SYSTEM_PROMPT,
      prompt: [
        "Conversation to title:",
        `User: ${firstUserText.slice(0, MAX_SOURCE_CHARS)}`,
        `Assistant: ${firstAssistantText.slice(0, MAX_SOURCE_CHARS)}`,
      ].join("\n\n"),
      maxOutputTokens: 24,
    });

    return normalizeTitle(text);
  } catch (error) {
    console.error("Session title generation failed", error);
    return null;
  }
}

function normalizeTitle(raw: string): string | null {
  const cleaned = raw
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/, "")
    .slice(0, MAX_TITLE_CHARS)
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}
