import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  type AgentMemory,
  agentMemories,
  type MemoryKind,
  type MemorySource,
  type MemoryStatus,
  type NewAgentMemory,
} from "@/db/schema";
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
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  confidence: number;
  status: MemoryStatus;
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
};

export type UpdateMemoryInput = {
  kind?: unknown;
  content?: unknown;
  source?: unknown;
  confidence?: unknown;
  status?: MemoryStatus;
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
  };

  const inserted = await db.insert(agentMemories).values(value).returning();
  return mapMemoryRow(inserted[0]);
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

  const rows = await db
    .update(agentMemories)
    .set({
      kind: input.kind === undefined ? existing.kind : parseMemoryKind(input.kind),
      content: input.content === undefined ? existing.content : parseMemoryContent(input.content),
      source:
        input.source === undefined
          ? existing.source
          : parseMemorySource(input.source, existing.source),
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

  return mapMemoryRow(rows[0]);
}

export async function archiveMemory(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Memory> {
  return updateMemory(id, { status: "archived" }, agentId, db);
}

function mapMemoryRow(row: AgentMemory): Memory {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    status: row.status,
    sessionId: row.sessionId,
    reviewProposalId: row.reviewProposalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
