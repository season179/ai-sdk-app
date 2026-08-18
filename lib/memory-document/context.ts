import "server-only";

import {
  escapeXml,
  projectMemoryDocument,
  renderMemoryDetails,
  renderMemoryIndex,
  validateMemoryEntry,
} from "@/lib/memory-document/format";
import { readMemoryDocument } from "@/lib/memory-document/repository";
import { estimateTokens, MEMORY_READ_TOKEN_LIMIT } from "@/lib/memory-document/token-estimate";
import type { MemoryDocument, MemoryDocumentEntry } from "@/lib/memory-document/types";
import { MEMORY_DOCUMENT_KEY_PATTERN } from "@/lib/memory-document/types";

export type MemoryIndexContext = {
  status: "hit" | "empty" | "degraded";
  version: number;
  block: string;
  indexBody: string;
  degradedKeys: string[];
};

export type MemoryReadResult = {
  status: "ok" | "degraded";
  content: string;
  returnedKeys: string[];
  missingKeys: string[];
  omittedKeys: string[];
  degradedKeys: string[];
  estimatedTokens: number;
  version: number;
};

export class MemoryReadInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryReadInputError";
  }
}

export async function loadMemoryIndexContext(
  agentId: string,
  dependencies: { read?: typeof readMemoryDocument } = {},
): Promise<MemoryIndexContext> {
  const read = dependencies.read ?? readMemoryDocument;
  let document: MemoryDocument;
  try {
    document = await read(agentId);
  } catch {
    return { status: "degraded", version: 0, block: "", indexBody: "", degradedKeys: [] };
  }

  const safeEntries: MemoryDocumentEntry[] = [];
  const degradedKeys: string[] = [];
  for (const entry of document.details) {
    try {
      validateMemoryEntry(entry);
      safeEntries.push(entry);
    } catch {
      if (typeof entry?.key === "string") degradedKeys.push(entry.key);
    }
  }
  const fullProjection = projectMemoryDocument(document.details);
  const storedMismatch =
    fullProjection.indexBody !== document.indexBody ||
    fullProjection.indexTokenCount !== document.indexTokenCount ||
    fullProjection.detailsTokenCount !== document.detailsTokenCount;
  const indexBody = renderMemoryIndex(safeEntries);
  const degraded = degradedKeys.length > 0 || storedMismatch;
  if (!indexBody) {
    return {
      status: degraded ? "degraded" : "empty",
      version: document.version,
      block: "",
      indexBody: "",
      degradedKeys,
    };
  }
  return {
    status: degraded ? "degraded" : "hit",
    version: document.version,
    block: `<memory_index trust="untrusted-user-memory-index" version="${document.version}">\n${escapeXml(indexBody)}\n</memory_index>`,
    indexBody,
    degradedKeys,
  };
}

export async function readMemoryEntries(
  input: { agentId: string; keys: unknown },
  dependencies: { read?: typeof readMemoryDocument } = {},
): Promise<MemoryReadResult> {
  const keys = parseMemoryReadKeys(input.keys);
  const document = await (dependencies.read ?? readMemoryDocument)(input.agentId);
  const byKey = new Map(document.details.map((entry) => [entry.key, entry]));
  const packed: MemoryDocumentEntry[] = [];
  const missingKeys: string[] = [];
  const omittedKeys: string[] = [];
  const degradedKeys: string[] = [];

  for (const key of keys) {
    const entry = byKey.get(key);
    if (!entry) {
      missingKeys.push(key);
      continue;
    }
    try {
      validateMemoryEntry(entry);
    } catch {
      degradedKeys.push(key);
      continue;
    }
    const candidate = renderMemoryDetails([...packed, entry], { preserveOrder: true });
    if (estimateTokens(candidate) > MEMORY_READ_TOKEN_LIMIT) {
      omittedKeys.push(key);
      continue;
    }
    packed.push(entry);
  }

  const content = renderMemoryDetails(packed, { preserveOrder: true });
  return {
    status: degradedKeys.length > 0 ? "degraded" : "ok",
    content,
    returnedKeys: packed.map((entry) => entry.key),
    missingKeys,
    omittedKeys,
    degradedKeys,
    estimatedTokens: estimateTokens(content),
    version: document.version,
  };
}

export function parseMemoryReadKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new MemoryReadInputError("keys must contain 1..5 memory keys.");
  }
  if (value.some((key) => typeof key !== "string" || !MEMORY_DOCUMENT_KEY_PATTERN.test(key))) {
    throw new MemoryReadInputError("Every memory key must match mem_<32 lowercase hex>.");
  }
  const keys = value as string[];
  if (new Set(keys).size !== keys.length) {
    throw new MemoryReadInputError("Memory keys must be unique.");
  }
  return keys;
}
