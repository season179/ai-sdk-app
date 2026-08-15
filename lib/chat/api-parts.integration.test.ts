import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { agentChatSessions, agentGroundedObservations, agentTraceEvents } from "@/db/schema";
import {
  appendSessionMessages,
  getChatSession,
  getChatSessionForRun,
  getSessionMessagesAfter,
  materializeMessageApiParts,
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
      materializeMessageApiParts(sessionId, messageId, projectedA),
      materializeMessageApiParts(sessionId, messageId, projectedB),
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
    const replayed = await materializeMessageApiParts(sessionId, messageId, [
      { type: "text", text: "different recomputation" },
    ]);
    const after = await getChatSessionForRun(sessionId, agentId);
    expect(replayed).toEqual(before?.modelMessages[0]?.parts);
    expect(after?.modelMessages[0]?.parts).toEqual(before?.modelMessages[0]?.parts);
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
