import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  agentMemories,
  agentMemoryVersions,
  type MemoryKind,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
} from "@/db/schema";
import { recordMemoryEvent } from "@/lib/consolidation/events";
import { ingestUserMemory } from "@/lib/consolidation/observations";
import { getMemoryPolicyVersion } from "@/lib/memory/config";
import { sanitizeTracePayload } from "@/lib/memory/redaction";
import { appendTraceEvents } from "@/lib/memory/trace";
import {
  appendMemoryVersion,
  createVersionedMemory,
  invalidateMemory,
  type VersionAuthority,
} from "@/lib/memory/versions";
import { MemoryNotFoundError, SelfImprovementInputError } from "@/lib/self-improvement/errors";
import {
  parseMemoryConfidence,
  parseMemoryContent,
  parseMemoryKind,
  parseMemorySource,
  parseMemoryType,
  parseValidityBounds,
} from "@/lib/self-improvement/validation";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

export type Memory = {
  id: string;
  agentId: string;
  kind: MemoryKind;
  memoryType: MemoryType;
  content: string;
  source: MemorySource;
  confidence: number;
  status: MemoryStatus;
  claimHash: string | null;
  isProtected: boolean;
  protectedAt: string | null;
  protectedBy: string | null;
  sessionId: string | null;
  reviewProposalId: string | null;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateMemoryInput = {
  kind: unknown;
  memoryType?: unknown;
  content: unknown;
  source?: unknown;
  confidence?: unknown;
  sessionId?: string | null;
  reviewProposalId?: string | null;
  agentId?: string;
  claimHash?: string | null;
  canonicalKey?: string | null;
  validFrom?: unknown;
  validTo?: unknown;
  sourceEventIds?: string[];
  authority?: VersionAuthority;
  extractorId?: string | null;
  modelId?: string | null;
  promptHash?: string | null;
  schemaVersion?: number;
  structured?: Record<string, unknown>;
  sourceReferenceTime?: Date | null;
  timePrecision?: "instant" | "day" | "month" | "year" | "unknown";
  sensitivityClass?: "normal" | "sensitive" | "restricted";
};

export type UpdateMemoryInput = {
  kind?: unknown;
  memoryType?: unknown;
  content?: unknown;
  source?: unknown;
  confidence?: unknown;
  status?: MemoryStatus;
  isProtected?: boolean;
  protectedBy?: string | null;
  validFrom?: unknown;
  validTo?: unknown;
  sourceEventIds?: string[];
  authority?: VersionAuthority;
  structured?: Record<string, unknown>;
  sourceReferenceTime?: Date | null;
  timePrecision?: "instant" | "day" | "month" | "year" | "unknown";
  sensitivityClass?: "normal" | "sensitive" | "restricted";
};

type CurrentRow = {
  root: typeof agentMemories.$inferSelect;
  version: typeof agentMemoryVersions.$inferSelect;
};

const activeRoot = () =>
  and(
    eq(agentMemories.status, "approved"),
    isNull(agentMemories.revokedAt),
    eq(agentMemories.tombstoned, false),
    eq(agentMemories.injectionBlocked, false),
  );
const activeVersion = () =>
  and(
    or(isNull(agentMemoryVersions.validDuring), sql`${agentMemoryVersions.validDuring} @> now()`),
    or(isNull(agentMemoryVersions.expiresAt), sql`${agentMemoryVersions.expiresAt} > now()`),
  );

export async function listMemories(
  agentId = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory[]> {
  const rows = await currentQuery(db)
    .where(and(eq(agentMemories.agentId, agentId), sql`${agentMemories.status} <> 'creating'`))
    .orderBy(desc(agentMemories.createdAt));
  return rows.map(mapMemoryRow);
}

export async function listApprovedMemories(
  agentId = DEFAULT_AGENT_ID,
  limit = 40,
  db: AppDbClient = getDb(),
): Promise<Memory[]> {
  const rows = await currentQuery(db)
    .where(and(eq(agentMemories.agentId, agentId), activeRoot(), activeVersion()))
    .orderBy(
      asc(agentMemories.kind),
      desc(agentMemoryVersions.confidence),
      asc(agentMemories.createdAt),
    )
    .limit(limit);
  return rows.map(mapMemoryRow);
}

export async function getMemoryById(
  id: string,
  agentId = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory | null> {
  const [row] = await currentQuery(db)
    .where(
      and(
        eq(agentMemories.id, id),
        eq(agentMemories.agentId, agentId),
        sql`${agentMemories.status} <> 'creating'`,
      ),
    )
    .limit(1);
  return row ? mapMemoryRow(row) : null;
}

export async function getMemoryByReviewProposalId(
  reviewProposalId: string,
  agentId = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory | null> {
  const [row] = await currentQuery(db)
    .where(
      and(
        eq(agentMemories.reviewProposalId, reviewProposalId),
        eq(agentMemories.agentId, agentId),
        sql`${agentMemories.status} <> 'creating'`,
      ),
    )
    .limit(1);
  return row ? mapMemoryRow(row) : null;
}

export async function createMemory(input: CreateMemoryInput, db?: AppDbClient): Promise<Memory> {
  if (!db) return getDb().transaction((tx) => createMemory(input, tx));
  const agentId = input.agentId ?? DEFAULT_AGENT_ID;
  const kind = parseMemoryKind(input.kind);
  const memoryType = parseMemoryType(input.memoryType, familyForKind(kind));
  const content = parseMemoryContent(input.content);
  const source = parseMemorySource(input.source);
  const confidence = parseMemoryConfidence(input.confidence);
  const bounds = parseValidityBounds(input.validFrom, input.validTo);
  const evidence = input.sourceEventIds?.length
    ? input.sourceEventIds
    : [
        await appendExplicitEvent(db, agentId, input.sessionId ?? null, "create", {
          kind,
          content,
        }),
      ];
  const result = await createVersionedMemory(
    {
      agentId,
      kind,
      memoryType,
      content,
      source,
      confidence,
      sourceEventIds: evidence,
      authority: input.authority ?? authorityForSource(source),
      sessionId: input.sessionId ?? null,
      reviewProposalId: input.reviewProposalId ?? null,
      claimHash: input.claimHash ?? null,
      canonicalKey: input.canonicalKey ?? null,
      validFrom: bounds.validFrom,
      validTo: bounds.validTo,
      structured: input.structured,
      sourceReferenceTime: input.sourceReferenceTime,
      timePrecision: input.timePrecision,
      sensitivityClass: input.sensitivityClass,
      extractorId: input.extractorId,
      modelId: input.modelId,
      promptHash: input.promptHash,
      schemaVersion: input.schemaVersion,
    },
    db,
  );
  if (source === "user") {
    await ingestUserMemory(result.root.id, content, { agentId, db, traceEventId: evidence[0] });
  }
  await recordMemoryEvent(
    {
      agentId,
      eventType: "created",
      origin: memoryEventOriginForSource(source),
      summary: `Created ${kind} memory (${source}).`,
      memoryId: result.root.id,
      memoryVersionId: result.version.id,
    },
    db,
  );
  return mapMemoryRow({ root: result.root, version: result.version });
}

export async function updateMemory(
  id: string,
  input: UpdateMemoryInput,
  agentId = DEFAULT_AGENT_ID,
  db?: AppDbClient,
): Promise<Memory> {
  if (!db) return getDb().transaction((tx) => updateMemory(id, input, agentId, tx));
  const existing = await getMemoryById(id, agentId, db);
  if (!existing) throw new MemoryNotFoundError(id);
  if (input.status === "archived") return archiveMemory(id, agentId, db, input.sourceEventIds);
  const isContentEdit =
    input.kind !== undefined || input.content !== undefined || input.confidence !== undefined;
  if (existing.isProtected && isContentEdit) {
    throw new SelfImprovementInputError("A protected memory cannot be edited or archived.");
  }
  const kind = input.kind === undefined ? existing.kind : parseMemoryKind(input.kind);
  const memoryType = parseMemoryType(input.memoryType, familyForKind(kind));
  const content =
    input.content === undefined ? existing.content : parseMemoryContent(input.content);
  const source =
    input.source !== undefined
      ? parseMemorySource(input.source, existing.source)
      : isContentEdit && existing.source === "consolidated"
        ? "user"
        : existing.source;
  const confidence =
    input.confidence === undefined
      ? existing.confidence
      : parseMemoryConfidence(input.confidence, existing.confidence);
  const bounds =
    input.validFrom === undefined && input.validTo === undefined
      ? null
      : parseValidityBounds(input.validFrom, input.validTo);
  const evidence = input.sourceEventIds?.length
    ? input.sourceEventIds
    : [await appendExplicitEvent(db, agentId, existing.sessionId, "update", { id, kind, content })];
  const result = await appendMemoryVersion(
    id,
    {
      agentId,
      kind,
      memoryType,
      content,
      source,
      confidence,
      sourceEventIds: evidence,
      authority: input.authority ?? "user",
      sessionId: existing.sessionId,
      reviewProposalId: existing.reviewProposalId,
      ...(bounds ? { validFrom: bounds.validFrom, validTo: bounds.validTo } : {}),
      structured: input.structured,
      sourceReferenceTime: input.sourceReferenceTime,
      timePrecision: input.timePrecision,
      sensitivityClass: input.sensitivityClass,
    },
    db,
  );
  await recordMemoryEvent(
    {
      agentId,
      eventType: "edited",
      origin: memoryEventOriginForSource(existing.source),
      summary: `Edited ${kind} memory.`,
      memoryId: id,
      memoryVersionId: result.version.id,
      detail: {
        version: 1,
        before: { kind: existing.kind, content: existing.content, source: existing.source },
        after: { kind, content, source },
      },
    },
    db,
  );
  return mapMemoryRow({ root: result.root, version: result.version });
}

export async function setMemoryProtection(
  id: string,
  isProtected: boolean,
  agentId = DEFAULT_AGENT_ID,
  protectedBy?: string,
  db?: AppDbClient,
): Promise<Memory> {
  if (!db) {
    return getDb().transaction((tx) =>
      setMemoryProtection(id, isProtected, agentId, protectedBy, tx),
    );
  }
  const existing = await getMemoryById(id, agentId, db);
  if (!existing) throw new MemoryNotFoundError(id);
  if (existing.isProtected === isProtected) return existing;
  await db
    .update(agentMemories)
    .set({
      isProtected,
      protectedAt: isProtected ? sql`now()` : null,
      protectedBy: isProtected ? (protectedBy ?? null) : null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(agentMemories.id, id), eq(agentMemories.agentId, agentId)));
  await recordMemoryEvent(
    {
      agentId,
      eventType: isProtected ? "protected" : "unprotected",
      origin: "user",
      summary: isProtected ? "Protected memory." : "Unprotected memory.",
      memoryId: id,
    },
    db,
  );
  return {
    ...existing,
    isProtected,
    protectedAt: isProtected ? new Date().toISOString() : null,
    protectedBy: isProtected ? (protectedBy ?? null) : null,
  };
}

export async function archiveMemory(
  id: string,
  agentId = DEFAULT_AGENT_ID,
  db?: AppDbClient,
  sourceEventIds?: string[],
): Promise<Memory> {
  if (!db) return getDb().transaction((tx) => archiveMemory(id, agentId, tx, sourceEventIds));
  const existing = await getMemoryById(id, agentId, db);
  if (!existing) throw new MemoryNotFoundError(id);
  if (existing.isProtected)
    throw new SelfImprovementInputError("A protected memory cannot be edited or archived.");
  const evidence = sourceEventIds?.length
    ? sourceEventIds
    : [await appendExplicitEvent(db, agentId, existing.sessionId, "archive", { id })];
  const result = await invalidateMemory(
    id,
    { agentId, sourceEventIds: evidence, source: existing.source, authority: "user" },
    db,
  );
  await recordMemoryEvent(
    {
      agentId,
      eventType: "archived",
      origin: memoryEventOriginForSource(existing.source),
      summary: `Archived ${existing.kind} memory.`,
      memoryId: id,
      memoryVersionId: result.version.id,
    },
    db,
  );
  return mapMemoryRow({ root: result.root, version: result.version });
}

function currentQuery(db: AppDbClient) {
  return db
    .select({ root: agentMemories, version: agentMemoryVersions })
    .from(agentMemories)
    .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId));
}

function mapMemoryRow(row: CurrentRow): Memory {
  return {
    id: row.root.id,
    agentId: row.root.agentId,
    kind: row.root.kind,
    memoryType: row.root.memoryType,
    content: row.version.content,
    source: row.version.source,
    confidence: row.version.confidence,
    status: row.root.status,
    claimHash: row.root.claimHash,
    isProtected: row.root.isProtected,
    protectedAt: row.root.protectedAt?.toISOString() ?? null,
    protectedBy: row.root.protectedBy,
    sessionId: row.root.sessionId,
    reviewProposalId: row.root.reviewProposalId,
    currentVersionId: row.version.id,
    createdAt: row.root.createdAt.toISOString(),
    updatedAt: row.root.updatedAt.toISOString(),
  };
}

async function appendExplicitEvent(
  db: AppDbClient,
  agentId: string,
  sessionId: string | null,
  operation: "create" | "update" | "archive",
  payload: Record<string, unknown>,
): Promise<string> {
  const traceId = `explicit-memory:${randomUUID()}`;
  const sanitized = sanitizeTracePayload({ operation, ...payload });
  const [event] = await appendTraceEvents(
    [
      {
        agentId,
        traceId,
        sequenceNo: 0,
        sessionId,
        eventType: "explicit_memory_write",
        actor: "user",
        trustClass: "user_assertion",
        payload: sanitized.payload,
        contentHash: sanitized.contentHash,
        idempotencyKey: traceId,
        retentionClass: "audit",
        policyVersion: getMemoryPolicyVersion(),
        occurredAt: new Date(),
      },
    ],
    db,
  );
  return event.id;
}

function familyForKind(kind: MemoryKind): MemoryType {
  return kind === "episode" ? "episodic" : kind === "procedure" ? "procedural" : "semantic";
}
function authorityForSource(source: MemorySource): VersionAuthority {
  return source === "user" ? "user" : source === "consolidated" ? "consolidated" : "reviewed";
}
function memoryEventOriginForSource(
  source: MemorySource,
): "user" | "review" | "consolidation" | "curator" {
  return source === "user"
    ? "user"
    : source === "review"
      ? "review"
      : source === "consolidated"
        ? "consolidation"
        : "curator";
}
