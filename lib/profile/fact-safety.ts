import { redactReadProjection } from "@/lib/memory/projection-safety";
import { detectPromptInjection, detectSecret, redactText } from "@/lib/memory/redaction";

export type CandidateFactSafetyIssue =
  | "prompt_injection"
  | "secret"
  | "secret_material"
  | "instruction_manipulation"
  | "read_projection";

export type CandidateFactSafetyResult = {
  safe: boolean;
  issues: CandidateFactSafetyIssue[];
};

const SECRET_NOUN =
  /\b(?:passwords?|passphrases?|pins?|otps?|tokens?|api[\s_-]*keys?|secrets?|credentials?|private[\s_-]*keys?)\b/giu;
const BENIGN_API_KEY_ROTATION =
  /\b(?:rotate|rotates|rotated|rotating)\s+(?:(?:our|their|the)\s+)?api[\s_-]*keys?\b|\bapi[\s_-]*key\s+rotation\b/giu;
const MANIPULATION_VERB =
  /\b(?:ignor(?:e|es|ed|ing)|disregard(?:s|ed|ing)?|overrid(?:e|es|den|ing)|overrode|bypass(?:es|ed|ing)?|forget(?:s|ting)?|forgot(?:ten)?)\b/giu;
const INSTRUCTION_TARGET =
  /\b(?:instructions?|directions?|directives?|prompts?|system[\s_-]*messages?|rules?|settings?|limits?|guidelines?|guardrails?|safety|polic(?:y|ies)|permissions?|authorization|access)\b/iu;
const SECOND_PERSON_REFERENCE = /\b(?:you|your|yours|yourself|yourselves)\b/iu;
const UNIVERSAL_DIRECTIVE =
  /\b(?:everything|anything)\s+(?:that\s+)?you\s+(?:(?:were|are|have\s+been)\s+)?(?:told|said|instructed)|\ball\s+(?:(?:my|the|your|our|their)\s+)?(?:rules?|settings?|limits?|guidelines?|guardrails?|safety)\b/iu;

/**
 * One fail-closed policy for text that may become a durable, model-visible profile fact.
 * The narrow API-key-rotation exception preserves ordinary credential-management prose;
 * it does not permit possessive, value-bearing, or otherwise secret-shaped material.
 */
export function inspectCandidateFactSafety(value: string): CandidateFactSafetyResult {
  const issues = new Set<CandidateFactSafetyIssue>();
  if (detectSecret(value)) issues.add("secret");
  if (detectPromptInjection(value)) issues.add("prompt_injection");

  const projection = redactReadProjection(value);
  if (projection.contaminated || projection.text !== value.trim()) issues.add("read_projection");

  const redacted = redactText(value);
  if (redacted.secretDetected || redacted.text !== value) issues.add("secret");
  if (containsSecretMaterialNoun(value)) issues.add("secret_material");
  if (containsInstructionManipulation(value)) issues.add("instruction_manipulation");

  return { safe: issues.size === 0, issues: [...issues] };
}

export function isCandidateFactSafe(value: string): boolean {
  return inspectCandidateFactSafety(value).safe;
}

function containsSecretMaterialNoun(value: string): boolean {
  const withoutBenignRotation = value.replace(BENIGN_API_KEY_ROTATION, " ");
  SECRET_NOUN.lastIndex = 0;
  return SECRET_NOUN.test(withoutBenignRotation);
}

function containsInstructionManipulation(value: string): boolean {
  MANIPULATION_VERB.lastIndex = 0;
  for (const match of value.matchAll(MANIPULATION_VERB)) {
    const remainder = value
      .slice((match.index ?? 0) + match[0].length)
      .split(/[.;!?。！？\n\r]/u, 1)[0];
    if (
      INSTRUCTION_TARGET.test(remainder) ||
      SECOND_PERSON_REFERENCE.test(remainder) ||
      UNIVERSAL_DIRECTIVE.test(remainder)
    ) {
      return true;
    }
  }
  return false;
}
