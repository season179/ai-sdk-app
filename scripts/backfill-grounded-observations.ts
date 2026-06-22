import "@/lib/scheduler/load-env";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentChatMessages, agentMemories } from "@/db/schema";
import type { ChatUIMessage } from "@/lib/chat/sessions";
import {
  advanceCheckpoint,
  ingestUserMemory,
  ingestUserTurn,
} from "@/lib/consolidation/observations";
import { closePool } from "@/lib/scheduler/db";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/**
 * Backfill grounded observations from existing chat + memory history (§8.3).
 *
 * Reads ONLY user-role chat messages and source='user' memories — never
 * assistant/system/tool. Inserts via the source unique indexes with
 * onConflictDoNothing, so it is idempotent and safe to re-run. Orders by the
 * tuple keys in §1.2 ((created_at, session_id, id) for chat, (created_at, id)
 * for memories) and advances the per-agent checkpoint as it goes.
 *
 * Supports --dry-run: scans and reports counts (including how many non-user
 * rows it skipped) without writing.
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = getDb();

  // Scan ALL user chat messages (no checkpoint boundary on backfill — we want
  // the full history). Order by the tuple key.
  const chatRows = await db
    .select({
      sessionId: agentChatMessages.sessionId,
      messageId: agentChatMessages.id,
      role: agentChatMessages.role,
      parts: agentChatMessages.parts,
      createdAt: agentChatMessages.createdAt,
    })
    .from(agentChatMessages)
    .where(eq(agentChatMessages.role, "user"))
    .orderBy(
      asc(agentChatMessages.createdAt),
      asc(agentChatMessages.sessionId),
      asc(agentChatMessages.id),
    );

  // Scan ALL source='user' memories.
  const memoryRows = await db
    .select({
      id: agentMemories.id,
      content: agentMemories.content,
      source: agentMemories.source,
      createdAt: agentMemories.createdAt,
    })
    .from(agentMemories)
    .where(and(eq(agentMemories.source, "user"), isNull(agentMemories.deletedAt)))
    .orderBy(asc(agentMemories.createdAt), asc(agentMemories.id));

  // Also report how many NON-user rows exist, so the operator can confirm the
  // firewall held (assistant/system rows scanned = 0 for ingestion, though they
  // exist in the table).
  const nonUserChatCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentChatMessages)
    .where(sql`${agentChatMessages.role} <> 'user'`);

  const nonUserMemoryCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMemories)
    .where(and(sql`${agentMemories.source} <> 'user'`, isNull(agentMemories.deletedAt)));

  console.log("Backfill grounded-observations scan:");
  console.log(`  user chat messages:        ${chatRows.length}`);
  console.log(`  source='user' memories:    ${memoryRows.length}`);
  console.log(`  non-user chat rows (skip): ${nonUserChatCount[0]?.count ?? 0}`);
  console.log(`  non-user memories (skip):  ${nonUserMemoryCount[0]?.count ?? 0}`);

  if (dryRun) {
    console.log("--dry-run: no rows written.");
    await closePool();
    return;
  }

  // Ingest user chat messages in session-id batches.
  let chatIngested = 0;
  const bySession = new Map<string, typeof chatRows>();
  for (const row of chatRows) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }
  for (const [sessionId, rows] of bySession) {
    const messages: ChatUIMessage[] = rows.map((row) => ({
      id: row.messageId,
      role: row.role as "user",
      parts: row.parts as ChatUIMessage["parts"],
    }));
    chatIngested += await ingestUserTurn(sessionId, messages, { db });
  }

  // Ingest user memories.
  let memoryIngested = 0;
  for (const row of memoryRows) {
    await ingestUserMemory(row.id, row.content, { db });
    memoryIngested += 1;
  }

  // Advance the checkpoint to the last scanned tuples so the live hook picks up
  // only newer rows.
  if (chatRows.length > 0 || memoryRows.length > 0) {
    const lastChat = chatRows[chatRows.length - 1];
    const lastMemory = memoryRows[memoryRows.length - 1];
    await advanceCheckpoint(
      DEFAULT_AGENT_ID,
      {
        lastChatMessageCreatedAt: lastChat?.createdAt ?? null,
        lastChatSessionId: lastChat?.sessionId ?? null,
        lastChatMessageId: lastChat?.messageId ?? null,
        lastMemoryCreatedAt: lastMemory?.createdAt ?? null,
        lastMemoryId: lastMemory?.id ?? null,
      },
      db,
    );
  }

  console.log(
    `Ingested ${chatIngested} chat observation(s), ${memoryIngested} memory observation(s).`,
  );
  await closePool();
}

main().catch((error) => {
  console.error("Backfill failed", error);
  closePool().finally(() => process.exit(1));
});
