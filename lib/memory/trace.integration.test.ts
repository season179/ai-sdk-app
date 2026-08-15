import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentChatMessages,
  agentChatSessions,
  agentGroundedObservations,
  agentTraceArtifacts,
  agentTraceEvents,
} from "@/db/schema";
import { appendSessionMessages } from "@/lib/chat/sessions";
import { buildUserMessageEvent } from "@/lib/memory/capture";
import { sanitizeTracePayload } from "@/lib/memory/redaction";
import { appendTraceEvents } from "@/lib/memory/trace";
import { closePool, getPool } from "@/lib/scheduler/db";

const available = Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("trace journal (integration)", () => {
  const agentId = randomUUID();
  const sessionIds: string[] = [];
  beforeAll(() => getPool());
  afterAll(async () => {
    const db = getDb();
    await db.delete(agentGroundedObservations).where(eq(agentGroundedObservations.agentId, agentId));
    await db.delete(agentTraceEvents).where(eq(agentTraceEvents.agentId, agentId));
    for (const sessionId of sessionIds) {
      await db.delete(agentChatMessages).where(eq(agentChatMessages.sessionId, sessionId));
      await db.delete(agentChatSessions).where(eq(agentChatSessions.id, sessionId));
    }
    await closePool();
  });

  it("deduplicates events and artifacts by database keys", async () => {
    const sanitized = sanitizeTracePayload({ text: "x".repeat(100_000) });
    const input = {
      agentId,
      traceId: randomUUID(),
      sequenceNo: 0,
      eventType: "environment_observation" as const,
      actor: "system" as const,
      trustClass: "system_record" as const,
      payload: sanitized.payload,
      contentHash: sanitized.contentHash,
      artifact: sanitized.artifact,
      idempotencyKey: `integration:${randomUUID()}`,
      retentionClass: "standard" as const,
      occurredAt: new Date(),
    };
    const first = await appendTraceEvents([input]);
    const second = await appendTraceEvents([input]);
    expect(first[0].id).toBe(second[0].id);
    const artifacts = await getDb()
      .select()
      .from(agentTraceArtifacts)
      .where(eq(agentTraceArtifacts.artifactHash, sanitized.artifact?.artifactHash ?? ""));
    expect(artifacts).toHaveLength(1);
  });

  it("commits user message, trace, and grounded observation together", async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    const message = {
      id: `msg-${randomUUID()}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Remember that integration evidence is linked." }],
    };
    const context = { agentId, sessionId, traceId: randomUUID() };
    const previous = process.env.AGENT_MEMORY_WRITE_ENABLED;
    process.env.AGENT_MEMORY_WRITE_ENABLED = "true";
    try {
      await appendSessionMessages(sessionId, [message], {
        agentId,
        createIfMissing: true,
        traceCapture: { events: [buildUserMessageEvent(context, message)], groundedUserMessages: [message] },
      });
    } finally {
      process.env.AGENT_MEMORY_WRITE_ENABLED = previous;
    }
    const observations = await getDb()
      .select()
      .from(agentGroundedObservations)
      .where(eq(agentGroundedObservations.sourceMessageId, message.id));
    expect(observations[0]?.traceEventId).toBeTruthy();
  });

  it("rolls back a bad trace savepoint without rolling back the message", async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    const message = {
      id: `msg-${randomUUID()}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Message survives optional capture." }],
    };
    const bad = buildUserMessageEvent({ agentId, sessionId, traceId: randomUUID() }, message);
    bad.sequenceNo = -1;
    const previous = process.env.AGENT_MEMORY_WRITE_ENABLED;
    process.env.AGENT_MEMORY_WRITE_ENABLED = "true";
    try {
      await appendSessionMessages(sessionId, [message], {
        agentId,
        createIfMissing: true,
        traceCapture: { events: [bad], groundedUserMessages: [message] },
      });
    } finally {
      process.env.AGENT_MEMORY_WRITE_ENABLED = previous;
    }
    const rows = await getDb()
      .select()
      .from(agentChatMessages)
      .where(eq(agentChatMessages.id, message.id));
    expect(rows).toHaveLength(1);
  });
});
