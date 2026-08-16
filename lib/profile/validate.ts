import { createHash } from "node:crypto";
import { redactReadProjection } from "@/lib/memory/projection-safety";
import { detectPromptInjection, detectSecret, redactText } from "@/lib/memory/redaction";
import type {
  ProfileFactCategory,
  ProfileFactV1,
  ProfileSourceHandle,
  ProfileTombstone,
} from "@/lib/profile/types";

const CATEGORIES = new Set<ProfileFactCategory>([
  "identity_context",
  "preferences_constraints",
  "active_projects_goals",
  "interaction_instructions",
]);
const SOURCE_ROLES = new Set(["primary", "corroborating", "context"]);

export type ProfileValidationResult = { valid: boolean; issues: string[] };

export function validateProfileCandidate(input: {
  body: string;
  facts: ProfileFactV1[];
  sources: ProfileSourceHandle[];
  previousFacts?: ProfileFactV1[];
  allowedReplacementFactKeys?: string[];
  tombstones?: ProfileTombstone[] | string[];
  maxChars: number;
}): ProfileValidationResult {
  const issues: string[] = [];
  const keys = new Set<string>();
  const tombstoneKeys = new Set(
    (input.tombstones ?? []).map((row) => (typeof row === "string" ? row : row.factKey)),
  );
  const sourceKeys = new Set<string>();
  const allowedReplacements = new Set(input.allowedReplacementFactKeys ?? []);

  if (!Array.isArray(input.facts)) issues.push("facts_not_array");
  for (const [index, fact] of input.facts.entries()) {
    if (!isPlainObject(fact)) {
      issues.push(`fact_${index}_invalid`);
      continue;
    }
    if (!fact.factKey || fact.factKey.length > 200 || keys.has(fact.factKey)) {
      issues.push(`fact_${index}_key_invalid_or_duplicate`);
    }
    keys.add(fact.factKey);
    if (!CATEGORIES.has(fact.category)) issues.push(`fact_${index}_category_invalid`);
    if (fact.authority !== "synthesized" && fact.authority !== "user") {
      issues.push(`fact_${index}_authority_invalid`);
    }
    if (typeof fact.protected !== "boolean") issues.push(`fact_${index}_protected_invalid`);
    if (!Number.isInteger(fact.order) || fact.order !== index)
      issues.push(`fact_${index}_order_invalid`);
    if (!isCompleteSentence(fact.sentence)) issues.push(`fact_${index}_incomplete_sentence`);
    if (isUnsafeText(fact.sentence)) issues.push(`fact_${index}_unsafe`);
    if (tombstoneKeys.has(fact.factKey)) issues.push(`fact_${index}_tombstoned`);
    const claimHash = profileClaimHash(fact.sentence);
    if (
      (input.tombstones ?? []).some((row) => typeof row !== "string" && row.claimHash === claimHash)
    ) {
      issues.push(`fact_${index}_claim_tombstoned`);
    }
  }

  for (const [index, source] of input.sources.entries()) {
    if (!keys.has(source.factKey)) issues.push(`source_${index}_unknown_fact`);
    const exactlyOne = Boolean(source.traceEventId) !== Boolean(source.memoryVersionId);
    if (!exactlyOne) issues.push(`source_${index}_invalid_lane`);
    if (!SOURCE_ROLES.has(source.sourceRole)) issues.push(`source_${index}_invalid_role`);
    sourceKeys.add(source.factKey);
  }
  for (const key of keys) {
    if (!sourceKeys.has(key)) issues.push(`fact_${key}_missing_source`);
  }

  for (const previous of input.previousFacts ?? []) {
    if (previous.authority !== "user" && !previous.protected) continue;
    if (tombstoneKeys.has(previous.factKey)) continue;
    const retained = input.facts.find((fact) => fact.factKey === previous.factKey);
    if (allowedReplacements.has(previous.factKey)) {
      if (!retained) issues.push(`authorized_replacement_${previous.factKey}_missing`);
      continue;
    }
    if (!retained || retained.sentence !== previous.sentence) {
      issues.push(`protected_fact_${previous.factKey}_not_preserved`);
    }
  }

  if ([...input.body].length > input.maxChars) issues.push("body_over_character_cap");
  if (isUnsafeText(input.body)) issues.push("body_unsafe");
  for (const fact of input.facts) {
    if (!containsExactlyOnce(input.body, fact.sentence)) {
      issues.push(`body_missing_or_duplicates_${fact.factKey}`);
    }
  }
  if (containsUnmanifestedText(input.body, input.facts)) {
    issues.push("body_contains_unmanifested_text");
  }
  for (const fact of input.facts) {
    if (!sentenceIsInCategory(input.body, fact.sentence, fact.category)) {
      issues.push(`body_category_mismatch_${fact.factKey}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

export function isCompleteSentence(value: string): boolean {
  const sentence = value.trim();
  if (sentence.length < 3 || sentence.length > 2000 || /[\r\n]/.test(sentence)) return false;
  if (!/[\p{L}\p{N}]/u.test(sentence)) return false;
  return /[.!?。！？]$/u.test(sentence);
}

export function countProfileCharacters(value: string): number {
  return [...value].length;
}

function containsExactlyOnce(body: string, sentence: string): boolean {
  const first = body.indexOf(sentence);
  return first >= 0 && body.indexOf(sentence, first + sentence.length) < 0;
}

function containsUnmanifestedText(body: string, facts: ProfileFactV1[]): boolean {
  let residual = body;
  for (const fact of facts) residual = residual.replace(fact.sentence, "");
  residual = residual
    .split("\n")
    .filter(
      (line) =>
        !/^\s*#{0,6}\s*(Identity and context|Preferences and constraints|Active projects and goals|Interaction instructions)\s*:?[\s#]*$/i.test(
          line,
        ),
    )
    .join("\n")
    .replace(/[\s#*_:\-–—•]+/gu, "");
  return residual.length > 0;
}

function isUnsafeText(value: string): boolean {
  if (detectSecret(value) || detectPromptInjection(value)) return true;
  const projection = redactReadProjection(value);
  if (projection.contaminated || projection.text !== value.trim()) return true;
  const redacted = redactText(value);
  return redacted.secretDetected || redacted.text !== value;
}

function sentenceIsInCategory(
  body: string,
  sentence: string,
  expected: ProfileFactCategory,
): boolean {
  let category: ProfileFactCategory = "identity_context";
  let offset = 0;
  for (const line of body.split("\n")) {
    const heading =
      /^\s*#{0,6}\s*(Identity and context|Preferences and constraints|Active projects and goals|Interaction instructions)\s*:?\s*#*\s*$/i.exec(
        line,
      );
    if (heading) {
      const normalized = heading[1].toLocaleLowerCase("en-US");
      category =
        normalized === "preferences and constraints"
          ? "preferences_constraints"
          : normalized === "active projects and goals"
            ? "active_projects_goals"
            : normalized === "interaction instructions"
              ? "interaction_instructions"
              : "identity_context";
    } else {
      const at = line.indexOf(sentence);
      if (at >= 0 && body.indexOf(sentence) === offset + at) return category === expected;
    }
    offset += line.length + 1;
  }
  return false;
}

function profileClaimHash(sentence: string): string {
  // Kept local to avoid a validate↔reconcile import cycle.
  return createHash("sha256")
    .update(
      sentence
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .trim()
        .replace(/\s+/gu, " ")
        .replace(/[.!?。！？]+$/u, ""),
    )
    .digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
