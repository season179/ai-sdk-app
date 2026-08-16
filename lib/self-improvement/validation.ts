import type { MemoryKind, MemorySource, MemoryType, ReviewProposalKind } from "@/db/schema";
import { redactReadProjection } from "@/lib/memory/projection-safety";
import { detectPromptInjection, detectSecret, redactText } from "@/lib/memory/redaction";
import { SelfImprovementInputError } from "@/lib/self-improvement/errors";

export const MEMORY_CONTENT_MAX = 2000;
export const MEMORY_CONFIDENCE_MIN = 0;
export const MEMORY_CONFIDENCE_MAX = 100;
export const REVIEW_PROPOSAL_PAYLOAD_MAX = 8192;

export const MEMORY_KINDS = [
  "preference",
  "fact",
  "correction",
  "persona",
  "episode",
  "procedure",
] as const;
export const MEMORY_TYPES = ["semantic", "episodic", "procedural"] as const;
const MEMORY_SOURCES = ["user", "review", "curated", "consolidated"] as const;
const REVIEW_PROPOSAL_KINDS = [
  "memory_create",
  "memory_edit",
  "memory_archive",
  "skill_create",
  "skill_edit",
  "skill_toggle",
] as const;

export function parseMemoryKind(value: unknown): MemoryKind {
  if (typeof value === "string" && MEMORY_KINDS.includes(value as (typeof MEMORY_KINDS)[number])) {
    return value as MemoryKind;
  }

  throw new SelfImprovementInputError(`Memory kind must be one of: ${MEMORY_KINDS.join(", ")}.`);
}

export function parseMemoryType(value: unknown, fallback: MemoryType = "semantic"): MemoryType {
  if (value == null) return fallback;
  if (typeof value === "string" && MEMORY_TYPES.includes(value as MemoryType)) {
    return value as MemoryType;
  }
  throw new SelfImprovementInputError(`Memory type must be one of: ${MEMORY_TYPES.join(", ")}.`);
}

export function parseValidityBounds(
  from: unknown,
  to: unknown,
): { validFrom: Date | null; validTo: Date | null } {
  const validFrom = typeof from === "string" && from ? new Date(from) : null;
  const validTo = typeof to === "string" && to ? new Date(to) : null;
  if (validFrom && Number.isNaN(validFrom.getTime())) {
    throw new SelfImprovementInputError("validFrom must be an ISO timestamp or null.");
  }
  if (validTo && Number.isNaN(validTo.getTime())) {
    throw new SelfImprovementInputError("validTo must be an ISO timestamp or null.");
  }
  if (validFrom && validTo && validFrom >= validTo) {
    throw new SelfImprovementInputError("validFrom must be earlier than validTo.");
  }
  return { validFrom, validTo };
}

export function parseMemorySource(value: unknown, fallback: MemorySource = "user"): MemorySource {
  if (value == null) {
    return fallback;
  }

  if (typeof value === "string" && MEMORY_SOURCES.includes(value as MemorySource)) {
    return value as MemorySource;
  }

  throw new SelfImprovementInputError(
    `Memory source must be one of: ${MEMORY_SOURCES.join(", ")}.`,
  );
}

export function parseMemoryContent(value: unknown): string {
  const content = typeof value === "string" ? value.trim() : "";

  if (!content) {
    throw new SelfImprovementInputError("Memory content is required.");
  }

  if (content.length > MEMORY_CONTENT_MAX) {
    throw new SelfImprovementInputError(
      `Memory content must be ${MEMORY_CONTENT_MAX.toLocaleString()} characters or fewer.`,
    );
  }

  const projection = redactReadProjection(content);
  const redacted = redactText(content);
  if (
    projection.contaminated ||
    detectSecret(content) ||
    detectPromptInjection(content) ||
    redacted.secretDetected ||
    redacted.text !== content
  ) {
    throw new SelfImprovementInputError(
      "Memory content contains a secret, read projection, or unsafe instruction.",
    );
  }

  return content;
}

export function parseMemoryConfidence(value: unknown, fallback = 100): number {
  if (value == null) {
    return fallback;
  }

  if (typeof value !== "number" && typeof value !== "string") {
    throw new SelfImprovementInputError("Memory confidence must be an integer.");
  }

  if (typeof value === "string" && !value.trim()) {
    throw new SelfImprovementInputError("Memory confidence must be an integer.");
  }

  const parsed = typeof value === "number" ? value : Number(value.trim());

  if (!Number.isInteger(parsed)) {
    throw new SelfImprovementInputError("Memory confidence must be an integer.");
  }

  if (parsed < MEMORY_CONFIDENCE_MIN || parsed > MEMORY_CONFIDENCE_MAX) {
    throw new SelfImprovementInputError(
      `Memory confidence must be between ${MEMORY_CONFIDENCE_MIN} and ${MEMORY_CONFIDENCE_MAX}.`,
    );
  }

  return parsed;
}

export function parseReviewProposalKind(value: unknown): ReviewProposalKind {
  if (typeof value === "string" && REVIEW_PROPOSAL_KINDS.includes(value as ReviewProposalKind)) {
    return value as ReviewProposalKind;
  }

  throw new SelfImprovementInputError(
    `Review proposal kind must be one of: ${REVIEW_PROPOSAL_KINDS.join(", ")}.`,
  );
}

export function parseRationale(value: unknown): string {
  const rationale = typeof value === "string" ? value.trim() : "";

  if (!rationale) {
    throw new SelfImprovementInputError("Proposal rationale is required.");
  }

  if (rationale.length > 2000) {
    throw new SelfImprovementInputError("Proposal rationale must be 2,000 characters or fewer.");
  }

  return rationale;
}

export function readPayloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelfImprovementInputError("Proposal payload must be an object.");
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SelfImprovementInputError("Proposal payload must be JSON serializable.");
  }

  if (!serialized || serialized.length > REVIEW_PROPOSAL_PAYLOAD_MAX) {
    throw new SelfImprovementInputError(
      `Proposal payload must be ${REVIEW_PROPOSAL_PAYLOAD_MAX.toLocaleString()} characters or fewer.`,
    );
  }

  return value as Record<string, unknown>;
}

export function readRequiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  const parsed = typeof value === "string" ? value.trim() : "";

  if (!parsed) {
    throw new SelfImprovementInputError(`Proposal payload field '${key}' is required.`);
  }

  return parsed;
}

export function readOptionalString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];

  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new SelfImprovementInputError(`Proposal payload field '${key}' must be a string.`);
  }

  return value.trim();
}
