import "server-only";

import { redactReadProjection } from "@/lib/memory/projection-safety";
import { detectPromptInjection, detectSecret } from "@/lib/memory/redaction";
import {
  estimateTokens,
  MEMORY_DETAILS_TOKEN_LIMIT,
  MEMORY_ENTRY_TOKEN_LIMIT,
  MEMORY_INDEX_TOKEN_LIMIT,
} from "@/lib/memory-document/token-estimate";
import {
  MEMORY_DOCUMENT_KEY_PATTERN,
  type MemoryDocument,
  type MemoryDocumentEntry,
} from "@/lib/memory-document/types";
import { isCandidateFactSafe } from "@/lib/profile/fact-safety";

export const MEMORY_DOCUMENT_ENTRY_LIMIT = 24;
export const MEMORY_DOCUMENT_ENTRY_DETAILS_LIMIT = 16;
export const MEMORY_DOCUMENT_TOTAL_DETAILS_LIMIT = 96;
export const MEMORY_SUMMARY_CODE_POINT_LIMIT = 200;
export const MEMORY_DETAIL_CODE_POINT_LIMIT = 2_000;

const UTC_RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u;
const LINE_BREAK = /[\r\n\u2028\u2029]/u;
// Tags plus comment/CDATA/declaration/processing-instruction forms: any of
// them could corrupt the XML-fenced index projection if rendered verbatim.
const MARKUP = /<\s*\/?\s*[a-z][^>]*>|<!|<\?/iu;

export class MemoryDocumentValidationError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "unsafe" | "capacity" = "invalid",
  ) {
    super(message);
    this.name = "MemoryDocumentValidationError";
  }
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function isMemoryDocumentKey(value: string): boolean {
  return MEMORY_DOCUMENT_KEY_PATTERN.test(value);
}

export function isUtcRfc3339(value: string): boolean {
  const match = UTC_RFC3339.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6])
  );
}

export function renderMemoryIndexEntry(entry: MemoryDocumentEntry): string {
  return `- [${entry.updatedAt}] [key=${entry.key}] ${entry.summary}`;
}

export function renderMemoryIndex(entries: readonly MemoryDocumentEntry[]): string {
  return [...entries]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(renderMemoryIndexEntry)
    .join("\n");
}

export function renderMemoryEntry(entry: MemoryDocumentEntry): string {
  return [
    renderMemoryIndexEntry(entry),
    ...entry.details.map((detail) => `  - [${detail.timestamp}] ${detail.text}`),
  ].join("\n");
}

export function renderMemoryDetails(
  entries: readonly MemoryDocumentEntry[],
  options: { preserveOrder?: boolean } = {},
): string {
  const ordered = options.preserveOrder
    ? [...entries]
    : [...entries].sort((a, b) => a.key.localeCompare(b.key));
  return ordered.map(renderMemoryEntry).join("\n");
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function projectMemoryDocument(entries: readonly MemoryDocumentEntry[]) {
  const details = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const indexBody = renderMemoryIndex(details);
  const detailsBody = renderMemoryDetails(details);
  return {
    details,
    indexBody,
    detailsBody,
    indexTokenCount: estimateTokens(indexBody),
    detailsTokenCount: estimateTokens(detailsBody),
  };
}

export function validateMemoryEntry(
  entry: MemoryDocumentEntry,
  options: { safety?: boolean } = {},
): void {
  if (!entry || typeof entry !== "object") {
    throw new MemoryDocumentValidationError("Memory entry must be an object.");
  }
  if (!isMemoryDocumentKey(entry.key)) {
    throw new MemoryDocumentValidationError("Memory entry key is malformed.");
  }
  if (!isUtcRfc3339(entry.updatedAt)) {
    throw new MemoryDocumentValidationError("Memory entry updatedAt must be RFC3339 UTC.");
  }
  validateLine(entry.summary, "summary", MEMORY_SUMMARY_CODE_POINT_LIMIT);
  if (!Array.isArray(entry.details) || entry.details.length < 1) {
    throw new MemoryDocumentValidationError("Each memory entry needs at least one detail line.");
  }
  if (entry.details.length > MEMORY_DOCUMENT_ENTRY_DETAILS_LIMIT) {
    throw new MemoryDocumentValidationError(
      "A memory entry has too many detail lines.",
      "capacity",
    );
  }
  const detailTexts = new Set<string>();
  for (const detail of entry.details) {
    if (!detail || typeof detail !== "object" || !isUtcRfc3339(detail.timestamp)) {
      throw new MemoryDocumentValidationError("Memory detail timestamp must be RFC3339 UTC.");
    }
    validateLine(detail.text, "detail", MEMORY_DETAIL_CODE_POINT_LIMIT);
    if (detailTexts.has(detail.text)) {
      throw new MemoryDocumentValidationError("Memory detail text must be unique within an entry.");
    }
    detailTexts.add(detail.text);
  }
  if (options.safety !== false) {
    assertSafeText(entry.summary, "summary");
    for (const detail of entry.details) assertSafeText(detail.text, "detail");
    assertSafeProjection(renderMemoryEntry(entry));
  }
  if (estimateTokens(renderMemoryEntry(entry)) > MEMORY_ENTRY_TOKEN_LIMIT) {
    throw new MemoryDocumentValidationError("A memory entry exceeds its token limit.", "capacity");
  }
}

export function validateMemoryEntries(
  entries: readonly MemoryDocumentEntry[],
  options: { safety?: boolean } = {},
): ReturnType<typeof projectMemoryDocument> {
  if (!Array.isArray(entries)) {
    throw new MemoryDocumentValidationError("Memory document details must be an array.");
  }
  if (entries.length > MEMORY_DOCUMENT_ENTRY_LIMIT) {
    throw new MemoryDocumentValidationError("Memory document has too many entries.", "capacity");
  }
  const keys = new Set<string>();
  let detailCount = 0;
  for (const entry of entries) {
    validateMemoryEntry(entry, options);
    if (keys.has(entry.key)) {
      throw new MemoryDocumentValidationError("Memory entry keys must be unique.");
    }
    keys.add(entry.key);
    detailCount += entry.details.length;
  }
  if (detailCount > MEMORY_DOCUMENT_TOTAL_DETAILS_LIMIT) {
    throw new MemoryDocumentValidationError(
      "Memory document has too many detail lines.",
      "capacity",
    );
  }
  const projection = projectMemoryDocument(entries);
  if (projection.indexTokenCount > MEMORY_INDEX_TOKEN_LIMIT) {
    throw new MemoryDocumentValidationError("Memory index exceeds its token limit.", "capacity");
  }
  if (projection.detailsTokenCount > MEMORY_DETAILS_TOKEN_LIMIT) {
    throw new MemoryDocumentValidationError("Memory details exceed their token limit.", "capacity");
  }
  if (options.safety !== false) {
    assertSafeProjection(projection.indexBody);
    assertSafeProjection(projection.detailsBody);
  }
  return projection;
}

export function validateMemoryDocument(document: MemoryDocument): void {
  if (!Number.isInteger(document.version) || document.version < 0) {
    throw new MemoryDocumentValidationError("Memory document version must be non-negative.");
  }
  const projection = validateMemoryEntries(document.details);
  if (
    document.indexBody !== projection.indexBody ||
    document.indexTokenCount !== projection.indexTokenCount ||
    document.detailsTokenCount !== projection.detailsTokenCount
  ) {
    throw new MemoryDocumentValidationError("Stored memory projections or estimates do not agree.");
  }
}

function validateLine(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string") {
    throw new MemoryDocumentValidationError(`Memory ${label} must be text.`);
  }
  const length = codePointLength(value);
  if (length < 1 || length > maximum || LINE_BREAK.test(value)) {
    throw new MemoryDocumentValidationError(
      `Memory ${label} must be one line containing 1..${maximum} Unicode code points.`,
    );
  }
}

function assertSafeText(value: string, label: string): void {
  const projection = redactReadProjection(value);
  if (
    detectSecret(value) ||
    detectPromptInjection(value) ||
    projection.contaminated ||
    !isCandidateFactSafe(value)
  ) {
    throw new MemoryDocumentValidationError(`Memory ${label} failed safety validation.`, "unsafe");
  }
}

function assertSafeProjection(value: string): void {
  if (hasControlCharacter(value) || MARKUP.test(value)) {
    throw new MemoryDocumentValidationError(
      "Memory projection contains prohibited markup.",
      "unsafe",
    );
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      // Zero-width and bidi formatting characters can visually spoof the
      // rendered index even though they are not classic C0/C1 controls.
      codePoint === 0x061c ||
      codePoint === 0x180e ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
    );
  });
}
