import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  type AgentMemory,
  agentMemories,
  type MemoryKind,
  type MemorySource,
  type MemoryStatus,
  type NewAgentMemory,
} from "@/db/schema";
import { recordMemoryEvent } from "@/lib/consolidation/events";
import { ingestUserMemory } from "@/lib/consolidation/observations";
import { MemoryNotFoundError, SelfImprovementInputError } from "@/lib/self-improvement/errors";
import {
  parseMemoryConfidence,
  parseMemoryContent,
  parseMemoryKind,
  parseMemorySource,
} from "@/lib/self-improvement/validation";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

export type Memory = {
  id: string;
  agentId: string;
  kind: MemoryKind;
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
  createdAt: string;
  updatedAt: string;
};

export type CreateMemoryInput = {
  kind: unknown;
  content: unknown;
  source?: unknown;
  confidence?: unknown;
  sessionId?: string | null;
  reviewProposalId?: string | null;
  agentId?: string;
  claimHash?: string | null;
};

export type UpdateMemoryInput = {
  kind?: unknown;
  content?: unknown;
  source?: unknown;
  confidence?: unknown;
  status?: MemoryStatus;
  isProtected?: boolean;
  protectedBy?: string | null;
};

export async function listMemories(
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory[]> {
  const rows = await db
    .select()
    .from(agentMemories)
    .where(and(eq(agentMemories.agentId, agentId), isNull(agentMemories.deletedAt)))
    .orderBy(desc(agentMemories.createdAt));

  return rows.map(mapMemoryRow);
}

export async function listApprovedMemories(
  agentId: string = DEFAULT_AGENT_ID,
  limit = 40,
  db: AppDbClient = getDb(),
): Promise<Memory[]> {
  const rows = await db
    .select()
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.status, "approved"),
        isNull(agentMemories.deletedAt),
      ),
    )
    .orderBy(asc(agentMemories.kind), desc(agentMemories.confidence), asc(agentMemories.createdAt))
    .limit(limit);

  return rows.map(mapMemoryRow);
}

export async function getMemoryById(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory | null> {
  const rows = await db
    .select()
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.id, id),
        eq(agentMemories.agentId, agentId),
        isNull(agentMemories.deletedAt),
      ),
    );

  return rows[0] ? mapMemoryRow(rows[0]) : null;
}

export async function getMemoryByReviewProposalId(
  reviewProposalId: string,
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory | null> {
  const rows = await db
    .select()
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.reviewProposalId, reviewProposalId),
        eq(agentMemories.agentId, agentId),
        isNull(agentMemories.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ? mapMemoryRow(rows[0]) : null;
}

export async function createMemory(
  input: CreateMemoryInput,
  db: AppDbClient = getDb(),
): Promise<Memory> {
  const value: NewAgentMemory = {
    agentId: input.agentId ?? DEFAULT_AGENT_ID,
    kind: parseMemoryKind(input.kind),
    content: parseMemoryContent(input.content),
    source: parseMemorySource(input.source),
    confidence: parseMemoryConfidence(input.confidence),
    sessionId: input.sessionId ?? null,
    reviewProposalId: input.reviewProposalId ?? null,
    claimHash: input.claimHash ?? null,
  };

  const inserted = await db.insert(agentMemories).values(value).returning();
  const memory = mapMemoryRow(inserted[0]);

  // §3a: a memory_user observation is ingested ONLY when the inserted row's
  // final source is exactly "user". Review/curated/consolidated memories can
  // never become evidence (§4.1 firewall). Fail-soft — ingestion must never
  // break the create path.
  if (memory.source === "user") {
    await ingestUserMemory(memory.id, memory.content, { agentId: memory.agentId, db }).catch(
      (error) => {
        console.error("Ingesting user memory failed", error);
      },
    );
  }

  // Fire a `created` timeline event. Origin follows the memory's source so a
  // user-authored memory is logged as `user`, a reviewed one as `review`, etc.
  // Fail-soft: recordMemoryEvent swallows its own errors.
  await recordMemoryEvent(
    {
      eventType: "created",
      origin: memoryEventOriginForSource(memory.source),
      summary: `Created ${memory.kind} memory (${memory.source}).`,
      memoryId: memory.id,
    },
    db,
  );

  return memory;
}

export async function updateMemory(
  id: string,
  input: UpdateMemoryInput,
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory> {
  const existing = await getMemoryById(id, agentId, db);

  if (!existing) {
    throw new MemoryNotFoundError(id);
  }

  const nextStatus = input.status ?? existing.status;

  if (nextStatus !== "approved" && nextStatus !== "archived") {
    throw new SelfImprovementInputError("Memory status must be approved or archived.");
  }

  const isContentEdit =
    input.kind !== undefined || input.content !== undefined || input.confidence !== undefined;

  // A protected row may not be content-edited or archived (§9.3). Protection
  // toggles go through setMemoryProtection, never here; a pure re-approval
  // (status only, no content change) stays allowed. The gate keys off the ACTION
  // (edit/archive), not the status field — the old `status !== "approved"` form
  // let a content edit slip through by sending status:"approved" alongside it.
  if (existing.isProtected && (isContentEdit || nextStatus === "archived")) {
    throw new SelfImprovementInputError("A protected memory cannot be edited or archived.");
  }

  // §9.3: editing a `consolidated` memory flips ownership — set source='user'
  // so the human's correction is ground truth and consolidation won't re-
  // archive/"correct" it. A content/kind/confidence edit on a consolidated row
  // is treated as a human correction.
  const sourceBefore = existing.source;
  const nextSource =
    input.source !== undefined
      ? parseMemorySource(input.source, existing.source)
      : isContentEdit && existing.source === "consolidated"
        ? "user"
        : existing.source;

  const rows = await db
    .update(agentMemories)
    .set({
      kind: input.kind === undefined ? existing.kind : parseMemoryKind(input.kind),
      content: input.content === undefined ? existing.content : parseMemoryContent(input.content),
      source: nextSource,
      confidence:
        input.confidence === undefined
          ? existing.confidence
          : parseMemoryConfidence(input.confidence, existing.confidence),
      status: nextStatus,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentMemories.id, id),
        eq(agentMemories.agentId, agentId),
        isNull(agentMemories.deletedAt),
      ),
    )
    .returning();

  const updated = mapMemoryRow(rows[0]);

  // Fire the appropriate timeline event. A status flip to archived is the
  // compaction mechanism; otherwise it's an edit. Fail-soft.
  if (nextStatus === "archived" && existing.status !== "archived") {
    await recordMemoryEvent(
      {
        eventType: "archived",
        origin: memoryEventOriginForSource(sourceBefore),
        summary: `Archived ${updated.kind} memory.`,
        memoryId: updated.id,
        detail: { version: 1, before: { status: existing.status } },
      },
      db,
    );
  } else {
    await recordMemoryEvent(
      {
        eventType: "edited",
        origin: memoryEventOriginForSource(sourceBefore),
        summary: `Edited ${updated.kind} memory.`,
        memoryId: updated.id,
        detail: {
          version: 1,
          before: { kind: existing.kind, content: existing.content, source: sourceBefore },
          after: { kind: updated.kind, content: updated.content, source: updated.source },
        },
      },
      db,
    );
  }

  return updated;
}

/**
 * Pin / unpin a memory (§9.3). Protected rows are excluded from
 * consolidation/curator archive + edit and show a lock badge. PATCH
 * /api/memories/:id with { isProtected } is the only path — there is no
 * /protect route.
 */
export async function setMemoryProtection(
  id: string,
  isProtected: boolean,
  agentId: string = DEFAULT_AGENT_ID,
  protectedBy?: string,
  db: AppDbClient = getDb(),
): Promise<Memory> {
  const existing = await getMemoryById(id, agentId, db);

  if (!existing) {
    throw new MemoryNotFoundError(id);
  }

  if (existing.isProtected === isProtected) {
    return existing;
  }

  const rows = await db
    .update(agentMemories)
    .set({
      isProtected,
      protectedAt: isProtected ? sql`now()` : null,
      protectedBy: isProtected ? (protectedBy ?? null) : null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentMemories.id, id),
        eq(agentMemories.agentId, agentId),
        isNull(agentMemories.deletedAt),
      ),
    )
    .returning();

  const updated = mapMemoryRow(rows[0]);

  await recordMemoryEvent(
    {
      eventType: isProtected ? "protected" : "unprotected",
      origin: "user",
      summary: isProtected ? "Protected memory." : "Unprotected memory.",
      memoryId: updated.id,
    },
    db,
  );

  return updated;
}

export async function archiveMemory(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory> {
  return updateMemory(id, { status: "archived" }, agentId, db);
}

/**
 * Agent-facing memory retrieval (§10.2). Read-only, lexical first: ILIKE-escaped
 * %query% over status='approved' AND deleted_at IS NULL, optional kind, ranked
 * by relevance. NO inserts, NO events, NO checkpoint updates. pgvector semantic
 * recall is the deferred upgrade behind the same signature.
 */
export async function searchMemories(
  agentId: string,
  query: string,
  opts: { kind?: MemoryKind; limit?: number; db?: AppDbClient } = {},
): Promise<Memory[]> {
  const db = opts.db ?? getDb();
  const limit = Math.max(1, Math.min(20, opts.limit ?? 10));
  const trimmed = query.trim();
  if (!trimmed) return [];

  const conditions = [
    eq(agentMemories.agentId, agentId),
    eq(agentMemories.status, "approved"),
    isNull(agentMemories.deletedAt),
  ];
  if (opts.kind) {
    conditions.push(eq(agentMemories.kind, opts.kind));
  }
  if (trimmed !== "*") {
    // Escape LIKE metacharacters so a query containing % or _ is literal.
    const escaped = trimmed.replace(/[%_\\]/g, "\\$&");
    conditions.push(ilike(agentMemories.content, `%${escaped}%`));
  }

  const rows = await db
    .select()
    .from(agentMemories)
    .where(and(...conditions))
    .orderBy(desc(agentMemories.confidence), desc(agentMemories.createdAt))
    .limit(limit);

  return rows.map(mapMemoryRow);
}

function mapMemoryRow(row: AgentMemory): Memory {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    status: row.status,
    claimHash: row.claimHash,
    isProtected: row.isProtected,
    protectedAt: row.protectedAt?.toISOString() ?? null,
    protectedBy: row.protectedBy,
    sessionId: row.sessionId,
    reviewProposalId: row.reviewProposalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Map a memory's source onto a MemoryEventOrigin for the timeline. */
function memoryEventOriginForSource(
  source: MemorySource,
): "user" | "review" | "consolidation" | "curator" {
  switch (source) {
    case "user":
      return "user";
    case "review":
      return "review";
    case "consolidated":
      return "consolidation";
    case "curated":
      return "curator";
  }
}
