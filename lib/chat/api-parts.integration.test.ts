import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentChatMessages,
  agentChatSessions,
  agentGroundedObservations,
  agentProfileVersions,
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
  const profileAId = randomUUID();
  const profileBId = randomUUID();
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
    await getDb()
      .insert(agentProfileVersions)
      .values([
        profileVersion(profileAId, agentId, 1, "Profile A."),
        profileVersion(profileBId, agentId, 2, "Profile B."),
      ]);
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
    await db.delete(agentProfileVersions).where(eq(agentProfileVersions.agentId, agentId));
    if (previousWriteEnabled === undefined) delete process.env.AGENT_MEMORY_WRITE_ENABLED;
    else process.env.AGENT_MEMORY_WRITE_ENABLED = previousWriteEnabled;
    await closePool();
  });

  it("materializes first-writer-wins under concurrency", async () => {
    const [first, second] = await Promise.all([
      materializeMessageRunProjection(sessionId, messageId, cleanParts, projectedA, profileAId),
      materializeMessageRunProjection(sessionId, messageId, cleanParts, projectedB, profileBId),
    ]);
    expect(first).toEqual(second);
    expect([
      { parts: projectedA, profileVersionId: profileAId },
      { parts: projectedB, profileVersionId: profileBId },
    ]).toContainEqual(first);
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
    expect(run?.profileVersionIds[messageId]).toMatch(/^.{36}$/);
  });

  it("replays the exact winning sidecar on later materialization/regenerate", async () => {
    const before = await getChatSessionForRun(sessionId, agentId);
    const replayed = await materializeMessageRunProjection(
      sessionId,
      messageId,
      cleanParts,
      [{ type: "text", text: "different recomputation" }],
      before?.profileVersionIds[messageId] === profileAId ? profileBId : profileAId,
    );
    const after = await getChatSessionForRun(sessionId, agentId);
    expect(replayed.parts).toEqual(before?.modelMessages[0]?.parts);
    expect(replayed.profileVersionId).toBe(before?.profileVersionIds[messageId]);
    expect(after?.modelMessages[0]?.parts).toEqual(before?.modelMessages[0]?.parts);
    expect(after?.profileVersionIds[messageId]).toBe(before?.profileVersionIds[messageId]);
  });

  it("leaves a legacy materialized sidecar permanently unbound", async () => {
    const legacySessionId = randomUUID();
    const legacyMessageId = `user-${randomUUID()}`;
    try {
      await appendSessionMessages(
        legacySessionId,
        [{ id: legacyMessageId, role: "user", parts: cleanParts }],
        { agentId, createIfMissing: true },
      );
      await getDb()
        .update(agentChatMessages)
        .set({ apiParts: projectedA })
        .where(
          and(
            eq(agentChatMessages.sessionId, legacySessionId),
            eq(agentChatMessages.id, legacyMessageId),
          ),
        );

      const replayed = await materializeMessageRunProjection(
        legacySessionId,
        legacyMessageId,
        cleanParts,
        projectedB,
        profileAId,
      );
      expect(replayed).toEqual({ parts: projectedA, profileVersionId: null });
    } finally {
      await getDb().delete(agentChatSessions).where(eq(agentChatSessions.id, legacySessionId));
    }
  });

  it("retries a clean-winner mismatch without binding the losing pair", async () => {
    const mismatchSessionId = randomUUID();
    const mismatchMessageId = `user-${randomUUID()}`;
    try {
      await appendSessionMessages(
        mismatchSessionId,
        [{ id: mismatchMessageId, role: "user", parts: cleanParts }],
        { agentId, createIfMissing: true },
      );
      await expect(
        materializeMessageRunProjection(
          mismatchSessionId,
          mismatchMessageId,
          [{ type: "text", text: "request-local loser" }],
          projectedA,
          profileAId,
        ),
      ).rejects.toBeInstanceOf(ChatMessagePartsMismatchError);

      const winner = await materializeMessageRunProjection(
        mismatchSessionId,
        mismatchMessageId,
        cleanParts,
        projectedB,
        profileBId,
      );
      expect(winner).toEqual({ parts: projectedB, profileVersionId: profileBId });
    } finally {
      await getDb().delete(agentChatSessions).where(eq(agentChatSessions.id, mismatchSessionId));
    }
  });

  it("preserves the target binding across regenerate and never copies profile blocks into history", async () => {
    const regenerateSessionId = randomUUID();
    const regenerateMessageId = `user-${randomUUID()}`;
    const assistantId = `assistant-${randomUUID()}`;
    try {
      const appended = await appendSessionMessages(
        regenerateSessionId,
        [{ id: regenerateMessageId, role: "user", parts: cleanParts }],
        { agentId, createIfMissing: true },
      );
      await materializeMessageRunProjection(
        regenerateSessionId,
        regenerateMessageId,
        cleanParts,
        projectedA,
        profileAId,
        appended.branchRevision,
      );
      await appendSessionMessages(
        regenerateSessionId,
        [{ id: assistantId, role: "assistant", parts: [{ type: "text", text: "answer" }] }],
        { expectedBranchRevision: appended.branchRevision },
      );

      const revised = await truncateConversationAfterMessage(
        regenerateSessionId,
        regenerateMessageId,
      );
      const run = await getChatSessionForRun(regenerateSessionId, agentId, revised);
      expect(run?.profileVersionIds[regenerateMessageId]).toBe(profileAId);
      expect(run?.modelMessages).toHaveLength(1);
      expect(JSON.stringify(run?.modelMessages)).not.toContain("<user_profile");
    } finally {
      await getDb().delete(agentChatSessions).where(eq(agentChatSessions.id, regenerateSessionId));
    }
  });

  it("journals a same-body retry and repoints grounded evidence to its new attempt", async () => {
    const retrySessionId = randomUUID();
    const retryMessageId = `user-${randomUUID()}`;
    const retryParts = [{ type: "text" as const, text: "same persisted retry body" }];
    const firstTraceId = randomUUID();
    const secondTraceId = randomUUID();
    const retryMessage = { id: retryMessageId, role: "user" as const, parts: retryParts };
    try {
      await appendSessionMessages(retrySessionId, [retryMessage], {
        agentId,
        createIfMissing: true,
        traceCapture: {
          events: [
            buildUserMessageEvent(
              { agentId, sessionId: retrySessionId, traceId: firstTraceId },
              retryMessage,
            ),
          ],
          groundedUserMessages: [retryMessage],
        },
      });
      const retry = await appendSessionMessages(retrySessionId, [retryMessage], {
        agentId,
        traceCapture: {
          events: [
            buildUserMessageEvent(
              { agentId, sessionId: retrySessionId, traceId: secondTraceId },
              retryMessage,
            ),
          ],
          groundedUserMessages: [retryMessage],
        },
      });
      expect(retry.traceCaptured).toBe(true);
      const [secondEvent] = await getDb()
        .select({ id: agentTraceEvents.id })
        .from(agentTraceEvents)
        .where(eq(agentTraceEvents.traceId, secondTraceId));
      const [observation] = await getDb()
        .select({ traceEventId: agentGroundedObservations.traceEventId })
        .from(agentGroundedObservations)
        .where(
          and(
            eq(agentGroundedObservations.sessionId, retrySessionId),
            eq(agentGroundedObservations.sourceMessageId, retryMessageId),
          ),
        );
      expect(secondEvent?.id).toBeTruthy();
      expect(observation?.traceEventId).toBe(secondEvent?.id);
    } finally {
      await getDb().delete(agentChatSessions).where(eq(agentChatSessions.id, retrySessionId));
    }
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
        materializeMessageRunProjection(
          duplicateSessionId,
          duplicateMessageId,
          persistedA ?? [],
          projected,
          null,
          appendA.branchRevision,
        ),
        materializeMessageRunProjection(
          duplicateSessionId,
          duplicateMessageId,
          persistedB ?? [],
          projected,
          null,
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
        materializeMessageRunProjection(
          branchSessionId,
          staleId,
          [{ type: "text", text: "stale branch" }],
          [{ type: "text", text: "stale projected" }],
          null,
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

function profileVersion(id: string, agentId: string, versionNo: number, body: string) {
  return {
    id,
    agentId,
    versionNo,
    body,
    facts: [],
    trigger: "scheduled" as const,
    authority: "synthesized" as const,
    tokenCount: 3,
    recordedDuring: sql`tstzrange(now(), null, '[)')`,
    promptHash: `test-${id}`,
    policyVersion: "profile-v1",
  };
}
