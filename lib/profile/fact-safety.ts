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

const MANIPULATION_VERB =
  /\b(?:ignor(?:e|es|ed|ing)|disregard(?:s|ed|ing)?|overrid(?:e|es|den|ing)|overrode|bypass(?:es|ed|ing)?|forget(?:s|ting)?|forgot(?:ten)?)\b/giu;
const INSTRUCTION_TARGET =
  /\b(?:instructions?|directions?|directives?|prompts?|system[\s_-]*messages?|rules?|settings?|limits?|guidelines?|guardrails?|safety|polic(?:y|ies)|permissions?|authorization|access)\b/iu;
const SECOND_PERSON_REFERENCE = /\b(?:you|your|yours|yourself|yourselves)\b/iu;
const SECOND_PERSON_SHORTHAND = /\b(?:u|ur)\b/iu;
const SECOND_PERSON_BEHAVIOR_CONTEXT =
  /\b(?:prefer(?:s|red|ring)?|want(?:s|ed|ing)?|need(?:s|ed|ing)?|expect(?:s|ed|ing)?|ask(?:s|ed|ing)?|tell(?:s|ing)?|told|remind(?:s|ed|ing)?|should|must|please)\b/iu;
const HISTORICAL_REPORT_PREFIX = /^i told you about\b/iu;
const UNIVERSAL_DIRECTIVE =
  /\b(?:everything|anything)\s+(?:that\s+)?you\s+(?:(?:were|are|have\s+been)\s+)?(?:told|said|instructed)|\ball\s+(?:(?:my|the|your|our|their)\s+)?(?:rules?|settings?|limits?|guidelines?|guardrails?|safety)\b/iu;
const GOVERNANCE_NOUN =
  /\b(?:rules?|guidelines?|guardrails?|instructions?|prompts?|polic(?:y|ies)|safety|assistants?|chatbots?|ai\s+models?|system\s+messages?|jailbreaks?)\b/iu;
const GOVERNANCE_COMPLIANCE_VERB =
  /\b(?:violat(?:e|es|ed|ing)|bypass(?:es|ed|ing)?|skip(?:s|ped|ping)?|evad(?:e|es|ed|ing)|circumvent(?:s|ed|ing)?|obey(?:s|ed|ing)?|compl(?:y|ies|ied|ying))\b/iu;
const GOVERNANCE_REFERENCE = /\b(?:it|them|these|those)\b/iu;
const PROFILE_HEADING_LINE =
  /^\s*#{0,6}\s*(?:identity and context|preferences and constraints|active projects and goals|interaction instructions)\s*:?\s*#*\s*$/gimu;

const ZERO_WIDTH =
  /(?:\u00ad|\u034f|[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff])/gu;
const COMBINING_MARK = /\p{M}+/gu;
const IN_WORD_SEPARATOR_CLASS = "[-._··•․‧∙⋅・]";
const OBFUSCATED_PREFIX_SEPARATOR_PATTERN = `(?:${IN_WORD_SEPARATOR_CLASS}|\\s)`;
const OBFUSCATED_PREFIX_SEPARATOR = new RegExp(OBFUSCATED_PREFIX_SEPARATOR_PATTERN, "u");
const OBFUSCATED_SINGLE_CHARACTER_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:[\\p{L}\\p{N}]${IN_WORD_SEPARATOR_CLASS}){2,}[\\p{L}\\p{N}](?![\\p{L}\\p{N}])`,
  "gu",
);
const ALL_IN_WORD_SEPARATORS = new RegExp(
  `(?<=[\\p{L}\\p{N}])${IN_WORD_SEPARATOR_CLASS}+(?=[\\p{L}\\p{N}])`,
  "gu",
);

const KEY_SHAPED_TOKEN =
  /(?:\bsk-(?:or-)?[a-z0-9][a-z0-9._-]{5,}|\b(?:pk_|ghp_|github_pat_)[a-z0-9][a-z0-9._-]{5,}|\bxox[a-z]-[a-z0-9][a-z0-9._-]{5,}|\bAKIA[0-9A-Z]{16}\b)/giu;
type ObfuscatedKeyPrefixFamily = {
  atoms: readonly string[];
  tailLength: number;
  exactTailLength?: boolean;
};

// One inventory drives separator-obfuscation coverage for every supported key family.
const OBFUSCATED_KEY_PREFIX_FAMILIES: readonly ObfuscatedKeyPrefixFamily[] = [
  { atoms: ["s", "k"], tailLength: 4 }, // sk-
  { atoms: ["s", "k", "o", "r"], tailLength: 4 }, // sk-or-
  { atoms: ["p", "k"], tailLength: 4 }, // pk_
  { atoms: ["g", "h", "p"], tailLength: 4 }, // ghp_
  { atoms: ["g", "i", "t", "h", "u", "b", "p", "a", "t"], tailLength: 4 }, // github_pat_
  { atoms: ["x", "o", "x", "[a-z]"], tailLength: 4 }, // xox[a-z]-
  { atoms: ["a", "k", "i", "a"], tailLength: 16, exactTailLength: true }, // AKIA
] as const;
const OBFUSCATED_KEY_SHAPED_TOKEN = new RegExp(
  OBFUSCATED_KEY_PREFIX_FAMILIES.map(({ atoms, tailLength, exactTailLength }) => {
    const tailRemainder = exactTailLength ? `{${tailLength - 1}}` : `{${tailLength - 1},}`;
    return `\\b${atoms.join(`${OBFUSCATED_PREFIX_SEPARATOR_PATTERN}*`)}${OBFUSCATED_PREFIX_SEPARATOR_PATTERN}*[a-z0-9](?:${IN_WORD_SEPARATOR_CLASS}*[a-z0-9])${tailRemainder}(?![a-z0-9])`;
  }).join("|"),
  "giu",
);
const JWT_SHAPED_TOKEN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu;
const LONG_ENCODED_TOKEN = /[A-Za-z0-9+/_=-]{20,}/gu;
const DIGIT_GROUP = /\d[\d -]*\d|\d/gu;

const ASCII_CONFUSABLES: Readonly<Record<string, string>> = {
  ı: "i",
  а: "a",
  е: "e",
  о: "o",
  с: "c",
  р: "p",
  х: "x",
  і: "i",
  А: "A",
  Е: "E",
  О: "O",
  С: "C",
  Р: "P",
  Х: "X",
  І: "I",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "y",
  χ: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};

/**
 * One fail-closed policy for text that may become a durable, model-visible profile fact.
 * Pattern detectors inspect raw and normalized matching-only views; raw identity checks remain
 * byte-faithful so normalization itself never makes ordinary Unicode text look redacted.
 */
export function inspectCandidateFactSafety(value: string): CandidateFactSafetyResult {
  const issues = new Set<CandidateFactSafetyIssue>();
  const matchingViews = candidateFactMatchingViews(value);
  const instructionViews = instructionMatchingViews(matchingViews);

  if (matchingViews.some((view) => detectSecret(view))) issues.add("secret");
  if (instructionViews.some((view) => detectPromptInjection(view))) {
    issues.add("prompt_injection");
  }

  const projection = redactReadProjection(value);
  if (projection.contaminated || projection.text !== value.trim()) issues.add("read_projection");

  if (
    matchingViews.some((view) => {
      const redacted = redactText(view);
      return redacted.secretDetected || redacted.text !== view;
    })
  ) {
    issues.add("secret");
  }
  if (matchingViews.some(containsValueShapedSecret)) issues.add("secret_material");
  if (instructionViews.some(containsInstructionManipulation)) {
    issues.add("instruction_manipulation");
  }
  if (instructionViews.some(containsGovernanceLanguage)) {
    issues.add("instruction_manipulation");
  }

  return { safe: issues.size === 0, issues: [...issues] };
}

export function isCandidateFactSafe(value: string): boolean {
  return inspectCandidateFactSafety(value).safe;
}

/** Exported for focused normalization regressions; never use this transformed text as stored prose. */
export function normalizeCandidateFactForMatching(value: string): string {
  let normalized = value.normalize("NFKC").normalize("NFKD").replace(COMBINING_MARK, "");
  normalized = Array.from(
    normalized,
    (character) => ASCII_CONFUSABLES[character] ?? character,
  ).join("");
  normalized = normalized.replace(ZERO_WIDTH, "").toLowerCase();
  return normalized.replace(OBFUSCATED_SINGLE_CHARACTER_WORD, (word) =>
    word.replace(new RegExp(IN_WORD_SEPARATOR_CLASS, "gu"), ""),
  );
}

function candidateFactMatchingViews(value: string): string[] {
  return [...new Set([value, normalizeCandidateFactForMatching(value)])];
}

function instructionMatchingViews(baseViews: string[]): string[] {
  const normalized = baseViews.at(-1) ?? "";
  return [...new Set([...baseViews, normalized.replace(ALL_IN_WORD_SEPARATORS, "")])];
}

function containsValueShapedSecret(value: string): boolean {
  KEY_SHAPED_TOKEN.lastIndex = 0;
  if (KEY_SHAPED_TOKEN.test(value)) return true;
  OBFUSCATED_KEY_SHAPED_TOKEN.lastIndex = 0;
  for (const match of value.matchAll(OBFUSCATED_KEY_SHAPED_TOKEN)) {
    if (/\d/u.test(match[0]) || OBFUSCATED_PREFIX_SEPARATOR.test(match[0])) return true;
  }
  JWT_SHAPED_TOKEN.lastIndex = 0;
  if (JWT_SHAPED_TOKEN.test(value)) return true;

  LONG_ENCODED_TOKEN.lastIndex = 0;
  for (const match of value.matchAll(LONG_ENCODED_TOKEN)) {
    const token = match[0];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(token)) {
      continue;
    }
    const hasLetter = /[A-Za-z]/u.test(token);
    const hasDigit = /\d/u.test(token);
    const isHex = /^[0-9a-f]+$/iu.test(token);
    if (isHex && hasLetter && hasDigit) return true;
    const hasLower = /[a-z]/u.test(token);
    const hasUpper = /[A-Z]/u.test(token);
    const hasBase64Punctuation = /[+/=]/u.test(token);
    if (hasLetter && (hasDigit || (hasLower && hasUpper) || hasBase64Punctuation)) {
      return true;
    }
  }

  DIGIT_GROUP.lastIndex = 0;
  for (const match of value.matchAll(DIGIT_GROUP)) {
    const digits = match[0].replace(/[^0-9]/gu, "");
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return true;
  }
  return false;
}

function passesLuhn(digits: string): boolean {
  if (/^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function containsGovernanceLanguage(value: string): boolean {
  PROFILE_HEADING_LINE.lastIndex = 0;
  const prose = value.replace(PROFILE_HEADING_LINE, " ");
  if (GOVERNANCE_NOUN.test(prose)) return true;
  if (containsDisallowedSecondPerson(prose)) return true;
  return GOVERNANCE_COMPLIANCE_VERB.test(prose) && GOVERNANCE_REFERENCE.test(prose);
}

function containsDisallowedSecondPerson(value: string): boolean {
  if (SECOND_PERSON_REFERENCE.test(value)) {
    if (!HISTORICAL_REPORT_PREFIX.test(value)) return true;
    if (SECOND_PERSON_REFERENCE.test(value.replace(HISTORICAL_REPORT_PREFIX, "i reported about"))) {
      return true;
    }
  }

  // Treat texting u/ur as second-person only in the same preference/address clause. This keeps
  // ordinary standalone uses ("the letter u", "U of M", "Uber") outside the governance gate.
  return value
    .split(/[.;!?。！？\n\r]/u)
    .some(
      (clause) =>
        SECOND_PERSON_SHORTHAND.test(clause) && SECOND_PERSON_BEHAVIOR_CONTEXT.test(clause),
    );
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
