import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { type AppDb, getDb } from "@/db";
import { agentMemoryDocuments } from "@/db/schema";
import { getMemoryPolicyVersion } from "@/lib/memory/config";
import { canonicalJson, sha256 } from "@/lib/memory/redaction";
import { appendTraceEvents } from "@/lib/memory/trace";
import {
  MemoryDocumentValidationError,
  projectMemoryDocument,
  renderMemoryEntry,
  validateMemoryEntries,
  validateMemoryEntry,
} from "@/lib/memory-document/format";
import { readMemoryDocument } from "@/lib/memory-document/repository";
import { estimateTokens } from "@/lib/memory-document/token-estimate";
import type {
  MemoryDocument,
  MemoryDocumentEntry,
  MemoryWriteMetadata,
} from "@/lib/memory-document/types";
import { inspectCandidateFactSafety } from "@/lib/profile/fact-safety";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

export class MemoryDocumentServiceInputError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "MemoryDocumentServiceInputError";
  }
}
export class MemoryDocumentServiceConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("The memory document changed. Reload it before trying again.");
    this.name = "MemoryDocumentServiceConflictError";
  }
}
export class MemoryDocumentEntryNotFoundError extends Error {
  constructor(key: string) {
    super(`No memory entry with key '${key}' was found.`);
    this.name = "MemoryDocumentEntryNotFoundError";
  }
}

export type MemoryDocumentControlPlaneEntry = MemoryDocumentEntry & {
  estimatedTokenCount: number;
  needsReview: boolean;
  safetyIssues: string[];
};
export type MemoryDocumentControlPlane = {
  version: number;
  indexBody: string;
  indexTokenCount: number;
  detailsTokenCount: number;
  entryCount: number;
  degraded: boolean;
  entries: MemoryDocumentControlPlaneEntry[];
};
export type MemoryDocumentMutationResult = {
  status: "applied" | "no_op";
  document: MemoryDocumentControlPlane;
};

type MutationInput = { expectedVersion: unknown; summary: unknown; details: unknown };
type CommitInput = {
  agentId: string;
  expectedVersion: number;
  entries: MemoryDocumentEntry[];
  metadata: MemoryWriteMetadata;
  now: Date;
};
type CommitResult =
  | { status: "applied"; version: number }
  | { status: "conflict"; version: number };
type ServiceDependencies = {
  readDocument: (agentId: string) => Promise<MemoryDocument>;
  commitDocument: (input: CommitInput) => Promise<CommitResult>;
  now: () => Date;
  mintKey: () => string;
  agentId: string;
};

const defaults: ServiceDependencies = {
  readDocument: (agentId) => readMemoryDocument(agentId),
  commitDocument: (input) => commitUiMemoryDocument(input),
  now: () => new Date(),
  mintKey: () => `mem_${randomUUID().replaceAll("-", "")}`,
  agentId: DEFAULT_AGENT_ID,
};

export function createMemoryDocumentService(overrides: Partial<ServiceDependencies> = {}) {
  const deps = { ...defaults, ...overrides };

  async function getDocument() {
    return toControlPlane(await deps.readDocument(deps.agentId));
  }

  async function createEntry(input: MutationInput): Promise<MemoryDocumentMutationResult> {
    const parsed = parseMutationInput(input);
    const current = await deps.readDocument(deps.agentId);
    assertExpectedVersion(parsed.expectedVersion, current.version);
    const now = deps.now();
    const timestamp = now.toISOString();
    const created: MemoryDocumentEntry = {
      key: deps.mintKey(),
      updatedAt: timestamp,
      summary: parsed.summary,
      details: parsed.details.map((text) => ({ timestamp, text })),
    };
    const entries = [...current.details, created];
    validateUiCandidate(current.details, entries, new Set([created.key]));
    const version = await commitOrThrow({
      agentId: deps.agentId,
      expectedVersion: current.version,
      entries,
      metadata: buildMetadata(entries, [], [created.key], []),
      now,
    });
    return {
      status: "applied",
      document: toControlPlane(documentAtVersion(current, entries, version)),
    };
  }

  async function updateEntry(
    key: string,
    input: MutationInput,
  ): Promise<MemoryDocumentMutationResult> {
    const parsed = parseMutationInput(input);
    const current = await deps.readDocument(deps.agentId);
    assertExpectedVersion(parsed.expectedVersion, current.version);
    const index = current.details.findIndex((entry) => entry.key === key);
    if (index < 0) throw new MemoryDocumentEntryNotFoundError(key);
    const prior = current.details[index];
    if (sameEntryText(prior, parsed.summary, parsed.details)) {
      return { status: "no_op", document: toControlPlane(current) };
    }
    const now = deps.now();
    const timestamp = now.toISOString();
    const retained = new Map(prior.details.map((detail) => [detail.text, detail.timestamp]));
    const next: MemoryDocumentEntry = {
      key,
      updatedAt: timestamp,
      summary: parsed.summary,
      details: parsed.details.map((text) => ({ text, timestamp: retained.get(text) ?? timestamp })),
    };
    const entries = [...current.details];
    entries[index] = next;
    validateUiCandidate(current.details, entries, new Set([key]));
    const version = await commitOrThrow({
      agentId: deps.agentId,
      expectedVersion: current.version,
      entries,
      metadata: buildMetadata(entries, [key], [], []),
      now,
    });
    return {
      status: "applied",
      document: toControlPlane(documentAtVersion(current, entries, version)),
    };
  }

  async function deleteEntry(
    key: string,
    rawVersion: unknown,
  ): Promise<MemoryDocumentMutationResult> {
    const expectedVersion = parseExpectedVersion(rawVersion);
    const current = await deps.readDocument(deps.agentId);
    assertExpectedVersion(expectedVersion, current.version);
    if (!current.details.some((entry) => entry.key === key))
      throw new MemoryDocumentEntryNotFoundError(key);
    const entries = current.details.filter((entry) => entry.key !== key);
    validateUiCandidate(current.details, entries, new Set());
    const now = deps.now();
    const version = await commitOrThrow({
      agentId: deps.agentId,
      expectedVersion: current.version,
      entries,
      metadata: buildMetadata(entries, [], [], [key]),
      now,
    });
    return {
      status: "applied",
      document: toControlPlane(documentAtVersion(current, entries, version)),
    };
  }

  async function commitOrThrow(input: CommitInput): Promise<number> {
    const result = await deps.commitDocument(input);
    if (result.status === "conflict") throw new MemoryDocumentServiceConflictError(result.version);
    return result.version;
  }
  return { getDocument, createEntry, updateEntry, deleteEntry };
}

const service = createMemoryDocumentService();
export const getMemoryDocumentControlPlane = service.getDocument;
export const createMemoryDocumentEntry = service.createEntry;
export const updateMemoryDocumentEntry = service.updateEntry;
export const deleteMemoryDocumentEntry = service.deleteEntry;

function parseMutationInput(input: MutationInput) {
  const expectedVersion = parseExpectedVersion(input.expectedVersion);
  if (typeof input.summary !== "string")
    throw new MemoryDocumentServiceInputError("summary must be text.", ["invalid_summary"]);
  if (!Array.isArray(input.details) || input.details.some((detail) => typeof detail !== "string")) {
    throw new MemoryDocumentServiceInputError("details must be an array of text lines.", [
      "invalid_details",
    ]);
  }
  return { expectedVersion, summary: input.summary, details: input.details as string[] };
}
function parseExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MemoryDocumentServiceInputError("expectedVersion must be a non-negative integer.", [
      "invalid_expected_version",
    ]);
  }
  return value;
}
function assertExpectedVersion(expected: number, current: number) {
  if (expected !== current) throw new MemoryDocumentServiceConflictError(current);
}
function sameEntryText(entry: MemoryDocumentEntry, summary: string, details: readonly string[]) {
  return (
    entry.summary === summary &&
    entry.details.length === details.length &&
    entry.details.every((detail, index) => detail.text === details[index])
  );
}
function validateUiCandidate(
  current: readonly MemoryDocumentEntry[],
  candidate: readonly MemoryDocumentEntry[],
  changedKeys: ReadonlySet<string>,
) {
  try {
    validateMemoryEntries(candidate, { safety: false });
    const currentByKey = new Map(current.map((entry) => [entry.key, entry] as const));
    for (const entry of candidate) {
      const prior = currentByKey.get(entry.key);
      if (changedKeys.has(entry.key) || !prior || prior !== entry) validateMemoryEntry(entry);
    }
  } catch (error) {
    if (error instanceof MemoryDocumentValidationError) {
      const issue =
        error.code === "capacity"
          ? "capacity"
          : error.code === "unsafe"
            ? "unsafe_text"
            : "invalid_entry";
      throw new MemoryDocumentServiceInputError(error.message, [issue]);
    }
    throw error;
  }
}
function inspectEntrySafety(entry: MemoryDocumentEntry): string[] {
  const issues = new Set<string>();
  for (const value of [entry.summary, ...entry.details.map((detail) => detail.text)]) {
    for (const issue of inspectCandidateFactSafety(value).issues) issues.add(issue);
  }
  try {
    validateMemoryEntry(entry);
  } catch (error) {
    if (error instanceof MemoryDocumentValidationError) issues.add(error.code);
    else throw error;
  }
  return [...issues];
}
function toControlPlane(document: MemoryDocument): MemoryDocumentControlPlane {
  const entries = document.details.map((entry) => {
    const safetyIssues = inspectEntrySafety(entry);
    return {
      ...entry,
      estimatedTokenCount: estimateTokens(renderMemoryEntry(entry)),
      needsReview: safetyIssues.length > 0,
      safetyIssues,
    };
  });
  return {
    version: document.version,
    indexBody: document.indexBody,
    indexTokenCount: document.indexTokenCount,
    detailsTokenCount: document.detailsTokenCount,
    entryCount: entries.length,
    degraded: entries.some((entry) => entry.needsReview),
    entries,
  };
}
function buildMetadata(
  entries: readonly MemoryDocumentEntry[],
  affectedKeys: string[],
  newKeys: string[],
  droppedKeys: string[],
): MemoryWriteMetadata {
  const projection = projectMemoryDocument(entries);
  const changed = new Set([...affectedKeys, ...newKeys]);
  return {
    entryCount: entries.length,
    indexTokenCount: projection.indexTokenCount,
    detailsTokenCount: projection.detailsTokenCount,
    affectedKeys,
    newKeys,
    droppedKeys,
    changedSummaries: entries
      .filter((entry) => changed.has(entry.key))
      .map((entry) => ({ key: entry.key, summary: entry.summary })),
  };
}
function documentAtVersion(
  current: MemoryDocument,
  entries: readonly MemoryDocumentEntry[],
  version: number,
): MemoryDocument {
  const projection = projectMemoryDocument(entries);
  return {
    ...current,
    version,
    indexBody: projection.indexBody,
    details: projection.details,
    indexTokenCount: projection.indexTokenCount,
    detailsTokenCount: projection.detailsTokenCount,
  };
}

async function commitUiMemoryDocument(
  input: CommitInput,
  db: AppDb = getDb(),
): Promise<CommitResult> {
  const projection = validateMemoryEntries(input.entries, { safety: false });
  const version = input.expectedVersion + 1;
  return db.transaction(async (tx) => {
    const values = {
      agentId: input.agentId,
      version,
      indexBody: projection.indexBody,
      details: projection.details,
      indexTokenCount: projection.indexTokenCount,
      detailsTokenCount: projection.detailsTokenCount,
      updatedAt: input.now,
    };
    const changed =
      input.expectedVersion === 0
        ? await tx
            .insert(agentMemoryDocuments)
            .values({ ...values, createdAt: input.now })
            .onConflictDoNothing({ target: agentMemoryDocuments.agentId })
            .returning({ version: agentMemoryDocuments.version })
        : await tx
            .update(agentMemoryDocuments)
            .set(values)
            .where(
              and(
                eq(agentMemoryDocuments.agentId, input.agentId),
                eq(agentMemoryDocuments.version, input.expectedVersion),
              ),
            )
            .returning({ version: agentMemoryDocuments.version });
    if (!changed.length) {
      const [winner] = await tx
        .select({ version: agentMemoryDocuments.version })
        .from(agentMemoryDocuments)
        .where(eq(agentMemoryDocuments.agentId, input.agentId))
        .limit(1);
      return { status: "conflict", version: winner?.version ?? input.expectedVersion };
    }
    const payload = {
      source: "manual_ui" as const,
      version,
      affectedKeys: input.metadata.affectedKeys,
      newKeys: input.metadata.newKeys,
      droppedKeys: input.metadata.droppedKeys,
      indexTokenCount: projection.indexTokenCount,
      detailsTokenCount: projection.detailsTokenCount,
    };
    await appendTraceEvents(
      [
        {
          agentId: input.agentId,
          traceId: `memory-document:${input.agentId}:${version}`,
          sequenceNo: 0,
          eventType: "explicit_memory_write",
          actor: "user",
          trustClass: "user_assertion",
          payload,
          contentHash: sha256(canonicalJson(payload)),
          idempotencyKey: `memory-document:${input.agentId}:v${version}`,
          retentionClass: "audit",
          policyVersion: getMemoryPolicyVersion(),
          occurredAt: input.now,
        },
      ],
      tx,
    );
    return { status: "applied", version };
  });
}
