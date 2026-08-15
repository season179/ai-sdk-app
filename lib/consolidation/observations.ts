import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  type AgentIngestionCheckpoint,
  agentChatMessages,
  agentGroundedObservations,
  agentIngestionCheckpoints,
  agentMemories,
  agentMemoryVersions,
  type GroundedObservationOrigin,
  type NewAgentGroundedObservation,
} from "@/db/schema";
import type { ChatUIMessage } from "@/lib/chat/sessions";
import { contentHash } from "@/lib/consolidation/normalize";
import { buildUserMessageEvent } from "@/lib/memory/capture";
import { appendTraceEvents } from "@/lib/memory/trace";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/**
 * The firewall (§3a, §4.1). The ONLY module that inserts grounded observations.
 * It is role-gated, not caller-trusted: appendSessionMessages is called for
 * assistant messages too (route.ts) and by the scheduled-task worker, so this
 * writer must never trust the caller's intent.
 *
 * Rules (non-negotiable):
 * - ingestUserTurn ingests ONLY parts where message.role === "user" and ONLY
 *   text parts — assistant/system/tool content is dropped.
 * - createMemory ingests a memory_user observation ONLY when the inserted row's
 *   final source is exactly "user".
 * - Dedupe is by source identity (unique per origin), NEVER by content_hash —
 *   repeated user statements are real evidence and must each count.
 *
 * Incremental via agent_ingestion_checkpoints (tuple watermark, §1.2): the
 * backfill and the live hook both advance the same per-agent checkpoint.
 */

const OBSERVATION_CONTENT_MAX = 2000;

/** Extract user-authored text from a batch of chat messages (role gate). */
export function extractUserText(messages: ChatUIMessage[]): {
  sessionId: string;
  messageId: string;
  text: string;
}[] {
  const out: { sessionId: string; messageId: string; text: string }[] = [];
  for (const message of messages) {
    // Role gate: only user turns. Assistant/system/tool content is dropped.
    if (message.role !== "user") {
      continue;
    }
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim();
    if (!text) {
      continue;
    }
    out.push({ sessionId: "", messageId: message.id, text });
  }
  return out;
}

/**
 * Ingest a user chat turn as grounded observations. Role-gated: silently drops
 * any non-user message. Idempotent via the (agent_id, session_id,
 * source_message_id) unique index. Splits over-long text into ≤2000-char chunks
 * so the content CHECK is never violated; each chunk is its own observation.
 */
export async function ingestUserTurn(
  sessionId: string,
  messages: ChatUIMessage[],
  opts: {
    agentId?: string;
    db?: AppDbClient;
    traceEventIds?: ReadonlyMap<string, string>;
  } = {},
): Promise<number> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const db = opts.db ?? getDb();

  const userTexts = extractUserText(messages);
  if (userTexts.length === 0) {
    return 0;
  }

  const traceEventIds = new Map(opts.traceEventIds ?? []);
  for (const item of userTexts) {
    if (!traceEventIds.has(item.messageId)) {
      const [event] = await appendTraceEvents(
        [
          buildUserMessageEvent(
            {
              agentId,
              sessionId,
              traceId: `grounded-chat:${sessionId}:${item.messageId}`,
            },
            {
              id: item.messageId,
              role: "user",
              parts: [{ type: "text", text: item.text }],
            },
          ),
        ],
        db,
      );
      traceEventIds.set(item.messageId, event.id);
    }
  }

  const rows: NewAgentGroundedObservation[] = [];
  for (const item of userTexts) {
    const chunks = chunkText(item.text, OBSERVATION_CONTENT_MAX);
    chunks.forEach((chunk, index) => {
      rows.push({
        agentId,
        sessionId,
        originKind: "chat_user" as GroundedObservationOrigin,
        // Each chunk needs a DISTINCT source_message_id: the chat_uniq index is
        // (agent_id, session_id, source_message_id), so chunks sharing one
        // message id would collide and onConflictDoNothing would silently drop
        // all but the first (losing the rest of an over-long turn). Suffix only
        // when there is more than one chunk, so single-chunk messages keep their
        // original id and re-ingest stays idempotent.
        sourceMessageId: chunks.length > 1 ? `${item.messageId}#${index}` : item.messageId,
        sourceMemoryId: null,
        traceEventId: traceEventIds.get(item.messageId) as string,
        content: chunk,
        contentHash: contentHash(chunk),
      });
    });
  }

  if (rows.length === 0) {
    return 0;
  }

  // onConflictDoNothing: the (agent_id, session_id, source_message_id) unique
  // index makes a re-ingest idempotent. Repeated user statements across turns
  // are NOT deduped — each carries its own source_message_id.
  const inserted = await db
    .insert(agentGroundedObservations)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: agentGroundedObservations.id });

  return inserted.length;
}

/**
 * Ingest a source='user' memory as a grounded observation. Called from
 * createMemory ONLY when the inserted row's final source is exactly "user".
 * Idempotent via the (agent_id, source_memory_id) unique index.
 */
export async function ingestUserMemory(
  memoryId: string,
  content: string,
  opts: { agentId?: string; db?: AppDbClient; traceEventId?: string | null } = {},
): Promise<void> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const db = opts.db ?? getDb();
  if (!opts.traceEventId) {
    throw new Error("User-memory observations require a trace event.");
  }

  const chunk = content.trim().slice(0, OBSERVATION_CONTENT_MAX);
  if (!chunk) {
    return;
  }

  await db
    .insert(agentGroundedObservations)
    .values({
      agentId,
      originKind: "memory_user" as GroundedObservationOrigin,
      sourceMemoryId: memoryId,
      sourceMessageId: null,
      sessionId: null,
      traceEventId: opts.traceEventId ?? null,
      content: chunk,
      contentHash: contentHash(chunk),
    })
    .onConflictDoNothing();
}

/** Split text into ≤maxLen chunks on word boundaries. */
function chunkText(text: string, maxLen: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return trimmed ? [trimmed] : [];
  }
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf(" ", maxLen);
    if (cut <= 0) {
      cut = maxLen;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * List grounded observations for an agent since a given createdAt (exclusive),
 * ordered by (created_at, id). The consolidation scan reads from this.
 */
export async function listGroundedObservations(
  agentId: string = DEFAULT_AGENT_ID,
  since?: Date,
  db: AppDbClient = getDb(),
) {
  const conditions = [
    eq(agentGroundedObservations.agentId, agentId),
    isNull(agentGroundedObservations.deletedAt),
  ];
  if (since) {
    conditions.push(gt(agentGroundedObservations.createdAt, since));
  }

  return db
    .select()
    .from(agentGroundedObservations)
    .where(and(...conditions))
    .orderBy(asc(agentGroundedObservations.createdAt), asc(agentGroundedObservations.id));
}

// --- Incremental watermark (§1.2) ---

/**
 * Read (or initialize) the per-agent ingestion checkpoint. Tuple watermark,
 * not a single id, because chat-message id is not globally unique.
 */
export async function getIngestionCheckpoint(
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<AgentIngestionCheckpoint> {
  const rows = await db
    .insert(agentIngestionCheckpoints)
    .values({ agentId })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) {
    return rows[0];
  }
  const existing = await db
    .select()
    .from(agentIngestionCheckpoints)
    .where(eq(agentIngestionCheckpoints.agentId, agentId));
  return existing[0];
}

/**
 * Advance the checkpoint to the given chat-message + memory tuples. Called by
 * the incremental scan after it has ingested everything up to and including
 * these keys.
 */
export async function advanceCheckpoint(
  agentId: string,
  next: {
    lastChatMessageCreatedAt?: Date | null;
    lastChatSessionId?: string | null;
    lastChatMessageId?: string | null;
    lastMemoryCreatedAt?: Date | null;
    lastMemoryId?: string | null;
  },
  db: AppDbClient = getDb(),
): Promise<void> {
  await db
    .update(agentIngestionCheckpoints)
    .set({
      lastChatMessageCreatedAt: next.lastChatMessageCreatedAt ?? null,
      lastChatSessionId: next.lastChatSessionId ?? null,
      lastChatMessageId: next.lastChatMessageId ?? null,
      lastMemoryCreatedAt: next.lastMemoryCreatedAt ?? null,
      lastMemoryId: next.lastMemoryId ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(agentIngestionCheckpoints.agentId, agentId));
}

/**
 * Incremental scan: read user-role chat messages and source='user' memories
 * created after the checkpoint, in tuple order. Returns the candidates to
 * ingest plus the next checkpoint to advance to. This is the shared core used
 * by both the live hook (per-turn) and the backfill script.
 */
export async function scanSinceCheckpoint(
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<{
  chatMessages: {
    sessionId: string;
    messageId: string;
    role: string;
    parts: unknown[];
    createdAt: Date;
  }[];
  memories: { id: string; content: string; source: string; createdAt: Date }[];
  checkpoint: AgentIngestionCheckpoint;
}> {
  const checkpoint = await getIngestionCheckpoint(agentId, db);

  // Chat messages: order by (created_at, session_id, id) per §1.2. Only user
  // role — the role gate is also enforced here so a scan can never surface
  // assistant/system content even if a future caller is careless.
  const chatConds = [
    eq(agentChatMessages.role, "user"),
    or(
      checkpoint.lastChatMessageCreatedAt
        ? gt(agentChatMessages.createdAt, checkpoint.lastChatMessageCreatedAt)
        : sql`true`,
    ),
  ];
  const chatMessages = await db
    .select({
      sessionId: agentChatMessages.sessionId,
      messageId: agentChatMessages.id,
      role: agentChatMessages.role,
      parts: agentChatMessages.parts,
      createdAt: agentChatMessages.createdAt,
    })
    .from(agentChatMessages)
    .where(and(...chatConds))
    .orderBy(
      asc(agentChatMessages.createdAt),
      asc(agentChatMessages.sessionId),
      asc(agentChatMessages.id),
    )
    .limit(5000);

  // Memories: join the canonical current version. Only source='user' —
  // review/curated/consolidated can never enter the grounded firewall.
  const memoryConds = [
    eq(agentMemoryVersions.source, "user"),
    or(
      checkpoint.lastMemoryCreatedAt
        ? gt(agentMemories.createdAt, checkpoint.lastMemoryCreatedAt)
        : sql`true`,
    ),
  ];
  const memories = await db
    .select({
      id: agentMemories.id,
      content: agentMemoryVersions.content,
      source: agentMemoryVersions.source,
      createdAt: agentMemories.createdAt,
    })
    .from(agentMemories)
    .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId))
    .where(and(...memoryConds))
    .orderBy(asc(agentMemories.createdAt), asc(agentMemories.id))
    .limit(5000);

  return { chatMessages, memories, checkpoint };
}
