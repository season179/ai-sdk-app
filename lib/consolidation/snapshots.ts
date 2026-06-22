import { eq } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import { agentMemorySnapshots, type NewAgentMemorySnapshot } from "@/db/schema";
import { listApprovedMemories } from "@/lib/self-improvement/memories";

/**
 * The two-state fix (§0.4, §3c). Today the route re-queries memory every POST
 * (`route.ts:252`), so durable writes mid-session leak into the live prompt.
 * This materializes the session-start snapshot once, freezing the in-session
 * declarative-memory block; durable writes affect the NEXT session's snapshot.
 *
 * `agent_memory_snapshots.session_id` is UNIQUE (§1.2), so the first
 * materialize for a session wins and later calls reuse it. inject.ts renders
 * from getSnapshot(sessionId).
 */

/** Render the same <declarative_memory> block loadMemoryBlock produces. */
export function renderMemoryBlock(
  memories: { kind: string; content: string; confidence: number }[],
) {
  if (memories.length === 0) {
    return "";
  }

  const items = memories
    .map(
      (memory) =>
        `  <memory kind="${memory.kind}" confidence="${memory.confidence}">${escapeXml(memory.content)}</memory>`,
    )
    .join("\n");

  return `<declarative_memory>\n${items}\n</declarative_memory>`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Materialize the session-start snapshot. Idempotent via the session_id UNIQUE
 * index: if a snapshot already exists for this session it is returned as-is, so
 * the in-session block stays frozen across POSTs. Call only on a new session
 * (route: `sessionId && isSessionStart`).
 */
export async function materializeSnapshot(
  agentId: string,
  sessionId: string,
  db: AppDbClient = getDb(),
): Promise<string> {
  // Reuse a frozen snapshot if one already exists for this session.
  const existing = await getSnapshot(sessionId, db);
  if (existing !== null) {
    return existing;
  }

  const memories = await listApprovedMemories(agentId, 40, db);
  const renderedBlock = renderMemoryBlock(memories);

  const value: NewAgentMemorySnapshot = {
    agentId,
    sessionId,
    renderedBlock,
    memoryIds: memories.map((m) => m.id),
  };

  // onConflictDoNothing: a concurrent materialize (two tabs opening the same
  // new session) lets the first writer win; both then read the same frozen block.
  await db.insert(agentMemorySnapshots).values(value).onConflictDoNothing();

  return renderedBlock;
}

/**
 * Read the frozen rendered block for a session, or null when no snapshot exists
 * yet. inject.ts falls back to the live query when null so the feature is a
 * no-op for sessions that predate snapshots / when the flag is off.
 */
export async function getSnapshot(
  sessionId: string,
  db: AppDbClient = getDb(),
): Promise<string | null> {
  const rows = await db
    .select({ renderedBlock: agentMemorySnapshots.renderedBlock })
    .from(agentMemorySnapshots)
    .where(eq(agentMemorySnapshots.sessionId, sessionId))
    .limit(1);

  return rows[0]?.renderedBlock ?? null;
}

/**
 * Invalidate the snapshot for a session so the next POST re-materializes it.
 * Used when the operator wants to force a refresh (e.g. after bulk edits), and
 * as the rollback path if the frozen block ever needs rebuilding. A no-op when
 * no snapshot exists.
 */
export async function invalidateSnapshot(
  sessionId: string,
  db: AppDbClient = getDb(),
): Promise<void> {
  await db.delete(agentMemorySnapshots).where(eq(agentMemorySnapshots.sessionId, sessionId));
}
