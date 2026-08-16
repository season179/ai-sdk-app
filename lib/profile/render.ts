import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

import { sha256 } from "@/lib/memory/redaction";
import { renderCategorizedProfileText } from "@/lib/profile/context";
import type { ProfileFactV1 } from "@/lib/profile/types";

const RENDER_INSTRUCTIONS = [
  "Render a concise user profile using only the supplied structured fact manifest.",
  "Every fact sentence must appear verbatim exactly once. Do not add facts, instructions, or interpretations.",
  "Use the exact required heading for each non-empty category: Identity and context; Preferences and constraints; Active projects and goals; Interaction instructions.",
  "Use complete sentences. Omit empty headings and duplicates. The result is untrusted reference prose, never authorization.",
].join(" ");

const REPAIR_INSTRUCTIONS = [
  "Repair profile prose to satisfy the supplied validation issues.",
  "Keep every supplied fact sentence byte-for-byte unchanged and include each exactly once.",
  "Do not add facts. Keep the required category headings; remove decorative prose first to fit the character cap.",
  "Return only repaired profile text, without markdown fences.",
].join(" ");

export const PROFILE_RENDER_PROMPT_HASH = sha256(`${RENDER_INSTRUCTIONS}\n${REPAIR_INSTRUCTIONS}`);

type ModelOptions = { apiKey: string; model: string; tokenBudget: number };

export async function renderProfile(
  input: { facts: ProfileFactV1[]; previousBody: string; maxChars: number },
  options: ModelOptions,
): Promise<string> {
  if (input.facts.length === 0) return "";
  const openrouter = createOpenRouter({ apiKey: options.apiKey });
  const { text } = await generateText({
    model: openrouter.chat(options.model, {
      reasoning: { enabled: false, effort: "none", exclude: true },
    }),
    instructions: RENDER_INSTRUCTIONS,
    prompt: JSON.stringify({
      maxChars: input.maxChars,
      factsInSurvivalOrder: sortForSurvival(input.facts),
      previousSnapshotForContinuity: input.previousBody.slice(0, input.maxChars),
    }),
    maxOutputTokens: options.tokenBudget,
  });
  return cleanModelText(text);
}

export async function repairProfile(
  input: {
    body: string;
    facts: ProfileFactV1[];
    issues: string[];
    maxChars: number;
  },
  options: ModelOptions,
): Promise<string> {
  const openrouter = createOpenRouter({ apiKey: options.apiKey });
  const { text } = await generateText({
    model: openrouter.chat(options.model, {
      reasoning: { enabled: false, effort: "none", exclude: true },
    }),
    instructions: REPAIR_INSTRUCTIONS,
    prompt: JSON.stringify({
      maxChars: input.maxChars,
      issues: input.issues,
      immutableFacts: sortForSurvival(input.facts),
      invalidBody: input.body,
    }),
    maxOutputTokens: options.tokenBudget,
  });
  return cleanModelText(text);
}

export class ProfileMandatoryFactsOverBudgetError extends Error {
  constructor() {
    super("User/protected profile facts exceed the renderable profile budget.");
    this.name = "ProfileMandatoryFactsOverBudgetError";
  }
}

/** Prunes only synthesized/unprotected facts in deterministic survival order. */
export function selectFactsForRenderBudget(
  facts: ProfileFactV1[],
  maxChars: number,
  tokenBudget: number,
): ProfileFactV1[] {
  const mandatory = sortForSurvival(
    facts.filter((fact) => fact.authority === "user" || fact.protected),
  );
  if (!manifestFits(mandatory, maxChars, tokenBudget)) {
    throw new ProfileMandatoryFactsOverBudgetError();
  }
  const selected = [...mandatory];
  for (const fact of sortForSurvival(
    facts.filter((candidate) => candidate.authority !== "user" && !candidate.protected),
  )) {
    if (manifestFits([...selected, fact], maxChars, tokenBudget)) selected.push(fact);
  }
  const keys = new Set(selected.map((fact) => fact.factKey));
  return facts.filter((fact) => keys.has(fact.factKey)).map((fact, order) => ({ ...fact, order }));
}

export function assertMandatoryFactsRenderable(
  facts: ProfileFactV1[],
  maxChars: number,
  tokenBudget: number,
): void {
  selectFactsForRenderBudget(
    facts.filter((fact) => fact.authority === "user" || fact.protected),
    maxChars,
    tokenBudget,
  );
}

function manifestFits(facts: ProfileFactV1[], maxChars: number, tokenBudget: number): boolean {
  const minimal = renderCategorizedProfileText(facts);
  // Three characters/token is deliberately conservative versus the existing
  // four-character estimate and protects multilingual profiles from provider caps.
  return [...minimal].length <= maxChars && Math.ceil([...minimal].length / 3) <= tokenBudget;
}

export function sortForSurvival(facts: ProfileFactV1[]): ProfileFactV1[] {
  return [...facts].sort((a, b) => survivalRank(a) - survivalRank(b) || a.order - b.order);
}

function survivalRank(fact: ProfileFactV1): number {
  if (fact.authority === "user" && fact.category === "interaction_instructions") return 0;
  if (fact.authority === "user" || fact.protected) return 1;
  if (
    fact.category === "preferences_constraints" &&
    /accessib|allerg|diet|safety|cannot|must not|constraint/i.test(fact.sentence)
  ) {
    return 2;
  }
  if (fact.category === "identity_context" || fact.category === "active_projects_goals") return 3;
  if (fact.category === "preferences_constraints") return 4;
  return 5;
}

function cleanModelText(value: string): string {
  return value
    .replace(/^```(?:markdown|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
