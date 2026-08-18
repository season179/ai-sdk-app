import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getDb } from "@/db";
import { agentChatMessages, agentChatSessions, agentTraceEvents } from "@/db/schema";
import {
  type ConversationSearchResponse,
  searchConversationsByTime,
} from "@/lib/chat/conversation-search";
import { buildScheduledToolEvents } from "@/lib/memory/capture";
import { appendTraceEvents } from "@/lib/memory/trace";
import { closePool, getPool } from "@/lib/scheduler/db";
import { executeMemoryTool } from "@/lib/self-improvement/memory-tools";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("deterministic temporal conversation search", () => {
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const liveSessionA = randomUUID();
  const liveSessionB = randomUUID();
  const deletedSession = randomUUID();
  const scheduledSession = randomUUID();
  const otherAgentSession = randomUUID();
  const traceId = randomUUID();
  const sessionIds = [
    liveSessionA,
    liveSessionB,
    deletedSession,
    scheduledSession,
    otherAgentSession,
  ];
  const from = new Date("2026-06-01T00:00:00.000Z");
  const tied = new Date("2026-06-01T01:00:00.123Z");
  const to = new Date("2026-06-02T00:00:00.000Z");

  beforeAll(async () => {
    getPool();
    const db = getDb();
    await db.insert(agentChatSessions).values([
      { id: liveSessionA, agentId, origin: "chat", title: "Live A" },
      { id: liveSessionB, agentId, origin: "chat", title: "Live B" },
      {
        id: deletedSession,
        agentId,
        origin: "chat",
        title: "Deleted",
        deletedAt: new Date(),
      },
      { id: scheduledSession, agentId, origin: "scheduled_task", title: "Scheduled" },
      { id: otherAgentSession, agentId: otherAgentId, origin: "chat", title: "Other agent" },
    ]);
    await db.insert(agentChatMessages).values([
      message(liveSessionA, "boundary-from", "user", "from is included", 0, from),
      {
        ...message(liveSessionA, "tie-user", "user", "clean user text", 1, tied),
        apiParts: [
          {
            type: "text",
            text: "<memory_context>bad</memory_context><available_skills>bad</available_skills><user_profile>bad</user_profile>",
          },
        ],
      },
      message(liveSessionA, "tie-assistant", "assistant", "clean assistant text", 2, tied),
      message(liveSessionA, "boundary-to", "user", "to is excluded", 3, to),
      message(liveSessionB, "tie-system", "system", "clean system text", 0, tied),
      message(deletedSession, "deleted", "user", "deleted marker", 0, tied),
      message(scheduledSession, "scheduled", "assistant", "scheduled marker", 0, tied),
      message(otherAgentSession, "other-agent", "user", "other agent marker", 0, tied),
    ]);
    // Force sub-millisecond precision so cursor pagination proves it never round-trips via Date.
    await db.execute(sql`update ${agentChatMessages}
      set created_at = '2026-06-01T01:00:00.123456Z'::timestamptz
      where ${agentChatMessages.sessionId} in (${liveSessionA}::uuid, ${liveSessionB}::uuid)
        and ${agentChatMessages.id} like 'tie-%'`);
  });

  afterAll(async () => {
    const db = getDb();
    await db
      .delete(agentTraceEvents)
      .where(and(eq(agentTraceEvents.agentId, agentId), eq(agentTraceEvents.traceId, traceId)));
    await db.delete(agentChatSessions).where(inArray(agentChatSessions.id, sessionIds));
    await closePool();
  });

  it("enforces agent/live-chat scope, half-open bounds, role filters, and clean parts", async () => {
    const response = await searchConversationsByTime(
      { from: from.toISOString(), to: to.toISOString(), order: "asc", limit: 20 },
      { agentId },
    );
    expect(response.results.map((result) => result.messageId)).toEqual([
      "boundary-from",
      ...expectedTieIds("asc"),
    ]);
    expect(response.results.map((result) => result.messageId)).not.toEqual(
      expect.arrayContaining(["boundary-to", "deleted", "scheduled", "other-agent"]),
    );

    const clean = response.results.find((result) => result.messageId === "tie-user");
    expect(clean).toMatchObject({
      excerpt: "clean user text",
      occurredAt: "2026-06-01T01:00:00.123456Z",
    });
    expect(JSON.stringify(response)).not.toMatch(
      /<memory_context>|<available_skills>|<skill_content>|<user_profile>/,
    );

    const assistants = await searchConversationsByTime(
      {
        from: from.toISOString(),
        to: to.toISOString(),
        role: "assistant",
        order: "asc",
        limit: 20,
      },
      { agentId },
    );
    expect(assistants.results.map((result) => result.messageId)).toEqual(["tie-assistant"]);
  });

  it("paginates timestamp ties without duplicates or skips in both directions", async () => {
    for (const order of ["asc", "desc"] as const) {
      const expected = await searchConversationsByTime(
        { from: from.toISOString(), to: to.toISOString(), order, limit: 20 },
        { agentId },
      );
      const collected: string[] = [];
      let cursor: string | undefined;
      do {
        const page: ConversationSearchResponse = await searchConversationsByTime(
          { from: from.toISOString(), to: to.toISOString(), order, limit: 1, cursor },
          { agentId },
        );
        collected.push(...page.results.map((result) => `${result.sessionId}:${result.messageId}`));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(collected).toEqual(
        expected.results.map((result) => `${result.sessionId}:${result.messageId}`),
      );
      expect(new Set(collected).size).toBe(collected.length);
    }
  });

  it("keeps server scope hidden in the tool and captures its result as derivative", async () => {
    const output = (await executeMemoryTool(
      "conversation_time_search",
      { from: from.toISOString(), to: to.toISOString(), role: "system", limit: 5 },
      {},
      { agentId },
    )) as ConversationSearchResponse;
    expect(output.results.map((result) => result.messageId)).toEqual(["tie-system"]);

    const captured = await appendTraceEvents(
      buildScheduledToolEvents(
        { agentId, sessionId: liveSessionA, traceId },
        "conversation_time_search",
        { from: from.toISOString(), to: to.toISOString() },
        output,
      ),
    );
    const toolResult = captured.find((event) => event.eventType === "tool_result");
    expect(toolResult).toMatchObject({
      actor: "tool",
      trustClass: "third_party_content",
      payload: {
        toolName: "conversation_time_search",
        derivative: true,
        derivativeSource: "read_projection",
      },
    });
  });

  function expectedTieIds(order: "asc" | "desc") {
    const ties = [
      { sessionId: liveSessionA, messageId: "tie-assistant" },
      { sessionId: liveSessionA, messageId: "tie-user" },
      { sessionId: liveSessionB, messageId: "tie-system" },
    ].sort((left, right) => {
      const tupleLeft = `${left.sessionId}:${left.messageId}`;
      const tupleRight = `${right.sessionId}:${right.messageId}`;
      return tupleLeft < tupleRight ? -1 : tupleLeft > tupleRight ? 1 : 0;
    });
    if (order === "desc") ties.reverse();
    return ties.map((tie) => tie.messageId);
  }
});

function message(
  sessionId: string,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  ordinal: number,
  createdAt: Date,
) {
  return {
    sessionId,
    id,
    role,
    parts: [{ type: "text" as const, text }],
    ordinal,
    createdAt,
  };
}
