import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { agentChatSessions, agentGroundedObservations, agentTraceEvents } from "@/db/schema";
import {
  appendSessionMessages,
  ChatBranchConflictError,
  getChatSession,
  getChatSessionForRun,
  getSessionMessagesAfter,
  materializeMessageApiParts,
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

  it("materializes first-writer-wins under concurrency", async () => {
    const [first, second] = await Promise.all([
      materializeMessageApiParts(sessionId, messageId, cleanParts, projectedA),
      materializeMessageApiParts(sessionId, messageId, cleanParts, projectedB),
    ]);
    expect(first).toEqual(second);
    expect([projectedA, projectedB]).toContainEqual(first);
  });

  it("uses api_parts for model history but keeps UI and SSE reads clean", async () => {
    const run = await getChatSessionForRun(sessionId, agentId);
    const ui = await getChatSession(sessionId, agentId);
    const tail = await getSessionMessagesAfter(sessionId, -1);
    const modelText = text(run?.modelMessages[0]?.parts);
    expect(modelText).toContain("<memory_context>");
    expect(text(run?.cleanMessages[0]?.parts)).toBe("raw user evidence only");
    expect(text(ui?.messages[0]?.parts)).not.toContain("<memory_context>");
    expect(text(tail[0]?.message.parts)).not.toContain("<memory_context>");
    expect(run?.apiPartMessageIds).toContain(messageId);
  });

  it("replays the exact winning sidecar on later materialization/regenerate", async () => {
    const before = await getChatSessionForRun(sessionId, agentId);
    const replayed = await materializeMessageApiParts(sessionId, messageId, cleanParts, [
      { type: "text", text: "different recomputation" },
    ]);
    const after = await getChatSessionForRun(sessionId, agentId);
    expect(replayed).toEqual(before?.modelMessages[0]?.parts);
    expect(after?.modelMessages[0]?.parts).toEqual(before?.modelMessages[0]?.parts);
  });

  it("binds concurrent duplicate submits and their sidecar to the clean winner", async () => {
    const duplicateSessionId = randomUUID();
    const duplicateMessageId = `user-${randomUUID()}`;
    const bodyA = [{ type: "text" as const, text: "winner candidate A" }];
    const bodyB = [{ type: "text" as const, text: "loser candidate B" }];
    try {
      const [appendA, appendB] = await Promise.all([
        appendSessionMessages(
          duplicateSessionId,
          [{ id: duplicateMessageId, role: "user", parts: bodyA }],
          { agentId, createIfMissing: true },
        ),
        appendSessionMessages(
          duplicateSessionId,
          [{ id: duplicateMessageId, role: "user", parts: bodyB }],
          { agentId, createIfMissing: true },
        ),
      ]);
      const persistedA = appendA.persistedMessages[0]?.parts;
      const persistedB = appendB.persistedMessages[0]?.parts;
      expect(persistedA).toEqual(persistedB);
      expect([bodyA, bodyB]).toContainEqual(persistedA);
      const projected = [
        {
          type: "text" as const,
          text: `${text(persistedA)}\n\n<memory_context>bound winner</memory_context>`,
        },
      ];
      await Promise.all([
        materializeMessageApiParts(
          duplicateSessionId,
          duplicateMessageId,
          persistedA ?? [],
          projected,
          appendA.branchRevision,
        ),
        materializeMessageApiParts(
          duplicateSessionId,
          duplicateMessageId,
          persistedB ?? [],
          projected,
          appendB.branchRevision,
        ),
      ]);
      const run = await getChatSessionForRun(duplicateSessionId, agentId);
      expect(run?.cleanMessages).toHaveLength(1);
      expect(run?.cleanMessages[0]?.parts).toEqual(persistedA);
      expect(text(run?.modelMessages[0]?.parts)).toContain(text(persistedA));
      expect(text(run?.modelMessages[0]?.parts)).not.toContain(
        text(persistedA) === "winner candidate A" ? "loser candidate B" : "winner candidate A",
      );
    } finally {
      await getDb().delete(agentChatSessions).where(eq(agentChatSessions.id, duplicateSessionId));
    }
  });

  it("rejects an assistant append after regenerate advances and truncates its branch", async () => {
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
      const revised = await truncateConversationAfterMessage(branchSessionId, forkId);
      expect(revised).toBe(stale.branchRevision + 1);
      await expect(
        appendSessionMessages(
          branchSessionId,
          [{ id: "assistant-stale", role: "assistant", parts: [{ type: "text", text: "orphan" }] }],
          { expectedBranchRevision: stale.branchRevision },
        ),
      ).rejects.toBeInstanceOf(ChatBranchConflictError);
      await expect(
        materializeMessageApiParts(
          branchSessionId,
          staleId,
          [{ type: "text", text: "stale branch" }],
          [{ type: "text", text: "stale projected" }],
          stale.branchRevision,
        ),
      ).rejects.toBeInstanceOf(ChatBranchConflictError);
      const run = await getChatSessionForRun(branchSessionId, agentId);
      expect(run?.cleanMessages.map((message) => message.id)).toEqual([forkId]);
    } finally {
      await getDb().delete(agentChatSessions).where(eq(agentChatSessions.id, branchSessionId));
    }
  });

  it("journals and grounds only clean parts, never the recall projection", async () => {
    const [trace] = await getDb()
      .select({ payload: agentTraceEvents.payload })
      .from(agentTraceEvents)
      .where(eq(agentTraceEvents.traceId, traceId));
    const [observation] = await getDb()
      .select({ content: agentGroundedObservations.content })
      .from(agentGroundedObservations)
      .where(eq(agentGroundedObservations.agentId, agentId));
    expect(trace?.payload.text).toBe("raw user evidence only");
    expect(JSON.stringify(trace?.payload)).not.toContain("<memory_context>");
    expect(observation?.content).toBe("raw user evidence only");
  });
});

function text(parts: Array<{ type: string; text?: string }> | undefined) {
  return parts?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n") ?? "";
}
