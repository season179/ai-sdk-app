import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentChatMessages,
  agentChatSessions,
  agentGroundedObservations,
  agentTraceEvents,
} from "@/db/schema";
import {
  appendSessionMessages,
  ChatBranchConflictError,
  ChatMessagePartsMismatchError,
  getChatSession,
  getChatSessionForRun,
  getSessionMessagesAfter,
  materializeMessageRunProjection,
  truncateConversationAfterMessage,
} from "@/lib/chat/sessions";
import { buildUserMessageEvent } from "@/lib/memory/capture";
import { closePool, getPool } from "@/lib/scheduler/db";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("chat api_parts replay boundary", () => {
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const messageId = `user-${randomUUID()}`;
  const traceId = randomUUID();
  const previousWriteEnabled = process.env.AGENT_MEMORY_WRITE_ENABLED;
  const cleanParts = [{ type: "text" as const, text: "raw user evidence only" }];
  const projectedA = [
    {
      type: "text" as const,
      text: "raw user evidence only\n\n<memory_context>A</memory_context>",
    },
  ];
  const projectedB = [
    {
      type: "text" as const,
      text: "raw user evidence only\n\n<memory_context>B</memory_context>",
    },
  ];

  beforeAll(async () => {
    process.env.AGENT_MEMORY_WRITE_ENABLED = "true";
    getPool();
    const message = { id: messageId, role: "user" as const, parts: cleanParts };
    await appendSessionMessages(sessionId, [message], {
      agentId,
      createIfMissing: true,
      traceCapture: {
        events: [buildUserMessageEvent({ agentId, sessionId, traceId }, message)],
        groundedUserMessages: [message],
      },
    });
  });

  afterAll(async () => {
    const db = getDb();
    await db
      .delete(agentGroundedObservations)
      .where(eq(agentGroundedObservations.agentId, agentId));
    await db.delete(agentTraceEvents).where(eq(agentTraceEvents.agentId, agentId));
    await db.delete(agentChatSessions).where(eq(agentChatSessions.id, sessionId));
    if (previousWriteEnabled === undefined) delete process.env.AGENT_MEMORY_WRITE_ENABLED;
    else process.env.AGENT_MEMORY_WRITE_ENABLED = previousWriteEnabled;
    await closePool();
  });

  it("materializes first-writer-wins without profile binding", async () => {
    const [first, second] = await Promise.all([
      materializeMessageRunProjection(sessionId, messageId, cleanParts, projectedA),
      materializeMessageRunProjection(sessionId, messageId, cleanParts, projectedB),
    ]);
    expect(first).toEqual(second);
    expect([{ parts: projectedA }, { parts: projectedB }]).toContainEqual(first);

    const [stored] = await getDb()
      .select({ profileVersionId: agentChatMessages.profileVersionId })
      .from(agentChatMessages)
      .where(and(eq(agentChatMessages.sessionId, sessionId), eq(agentChatMessages.id, messageId)));
    expect(stored?.profileVersionId).toBeNull();
  });

  it("replays api_parts while UI, SSE, and evidence remain clean", async () => {
    const before = await getChatSessionForRun(sessionId, agentId);
    const replayed = await materializeMessageRunProjection(sessionId, messageId, cleanParts, [
      { type: "text", text: "different recomputation" },
    ]);
    const after = await getChatSessionForRun(sessionId, agentId);
    const ui = await getChatSession(sessionId, agentId);
    const tail = await getSessionMessagesAfter(sessionId, -1);

    expect(replayed.parts).toEqual(before?.modelMessages[0]?.parts);
    expect(after?.modelMessages[0]?.parts).toEqual(before?.modelMessages[0]?.parts);
    expect(text(before?.modelMessages[0]?.parts)).toContain("<memory_context>");
    expect(text(before?.cleanMessages[0]?.parts)).toBe("raw user evidence only");
    expect(text(ui?.messages[0]?.parts)).not.toContain("<memory_context>");
    expect(text(tail[0]?.message.parts)).not.toContain("<memory_context>");
    expect(before?.apiPartMessageIds).toContain(messageId);
  });

  it("rejects clean-winner mismatches and stale branches", async () => {
    await expect(
      materializeMessageRunProjection(
        sessionId,
        messageId,
        [{ type: "text", text: "request-local loser" }],
        projectedA,
      ),
    ).rejects.toBeInstanceOf(ChatMessagePartsMismatchError);

    const branchSessionId = randomUUID();
    const forkId = `user-${randomUUID()}`;
    const staleId = `user-${randomUUID()}`;
    try {
      await appendSessionMessages(
        branchSessionId,
        [{ id: forkId, role: "user", parts: [{ type: "text", text: "fork" }] }],
        { agentId, createIfMissing: true },
      );
      const stale = await appendSessionMessages(branchSessionId, [
        { id: staleId, role: "user", parts: [{ type: "text", text: "stale branch" }] },
      ]);
      await truncateConversationAfterMessage(branchSessionId, forkId);
      await expect(
        materializeMessageRunProjection(
          branchSessionId,
          staleId,
          [{ type: "text", text: "stale branch" }],
          [{ type: "text", text: "stale projected" }],
          stale.branchRevision,
        ),
      ).rejects.toBeInstanceOf(ChatBranchConflictError);
    } finally {
      await getDb().delete(agentChatSessions).where(eq(agentChatSessions.id, branchSessionId));
    }
  });

  it("journals and grounds only clean parts", async () => {
    const [trace] = await getDb()
      .select({ payload: agentTraceEvents.payload })
      .from(agentTraceEvents)
      .where(eq(agentTraceEvents.traceId, traceId));
    const [observation] = await getDb()
      .select({ content: agentGroundedObservations.content })
      .from(agentGroundedObservations)
      .where(
        and(
          eq(agentGroundedObservations.agentId, agentId),
          eq(agentGroundedObservations.sessionId, sessionId),
        ),
      );
    expect(trace?.payload.text).toBe("raw user evidence only");
    expect(JSON.stringify(trace?.payload)).not.toContain("<memory_context>");
    expect(observation?.content).toBe("raw user evidence only");
  });
});

function text(parts: Array<{ type: string; text?: string }> | undefined) {
  return parts?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n") ?? "";
}
