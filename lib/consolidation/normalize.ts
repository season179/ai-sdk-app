import { createHash } from "node:crypto";

/**
 * Claim normalization (§2 normalize.ts). Produces a stable `claim_key` (the
 * normalized text used for grouping/dedupe) and a `claim_hash` (the hash stored
 * on durable rows for the partial unique index, §1.1). Concept tagging is a
 * cheap lexical pass — good enough to feed the `concept` score component without
 * a model call.
 */

/** Whitespace + case normalization, punctuation stripped. */
export function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

/** SHA-256 of the normalized claim, hex. Stable across runs and agents. */
export function claimHash(text: string): string {
  return createHash("sha256").update(normalizeClaim(text)).digest("hex");
}

/**
 * Cheap lexical concept tags — downcased alpha runs of length ≥ 4 that are not
 * stop words. Used only as a signal for the `concept` score component (§4.2);
 * never as evidence identity. Deduped and capped.
 */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "have",
  "your",
  "yours",
  "what",
  "when",
  "which",
  "their",
  "there",
  "then",
  "than",
  "will",
  "want",
  "like",
  "just",
  "they",
  "them",
  "into",
  "about",
  "after",
  "before",
  "should",
  "would",
  "could",
  "does",
  "dont",
  "cant",
  "wont",
  "always",
  "never",
  "please",
]);

export function conceptTags(text: string, max = 12): string[] {
  const normalized = normalizeClaim(text);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const word of normalized.split(" ")) {
    if (word.length < 4 || STOP_WORDS.has(word) || seen.has(word)) {
      continue;
    }
    seen.add(word);
    tags.push(word);
    if (tags.length >= max) {
      break;
    }
  }
  return tags;
}

/** Hash of a raw (unnormalized) content blob — used for grounded-observation content_hash. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
