import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { agentChatSessions, agentReviewReceipts, agentReviewStates } from "@/db/schema";
import { MEMORY_EXTRACTOR_ID } from "@/lib/memory/config";
import { closePool, getPool } from "@/lib/scheduler/db";
import { resetReviewCadenceAfterEnqueue } from "@/lib/self-improvement/enqueue";
import { type RunTurnReviewResult, runTurnReview } from "@/lib/self-improvement/review";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("turn review watermark and receipt (integration)", () => {
  const agentId = randomUUID();
  const sessionId = randomUUID();

  beforeAll(async () => {
    getPool();
    await getDb().insert(agentChatSessions).values({ id: sessionId, agentId });
  });

  afterAll(async () => {
    await getDb().delete(agentReviewReceipts).where(eq(agentReviewReceipts.agentId, agentId));
    await getDb().delete(agentReviewStates).where(eq(agentReviewStates.agentId, agentId));
    await getDb().delete(agentChatSessions).where(eq(agentChatSessions.id, sessionId));
    await closePool();
  });

  it("leaves the success watermark unchanged after enqueue cadence reset", async () => {
    const lastReviewedAt = new Date("2026-01-02T03:04:05.000Z");
    await getDb().insert(agentReviewStates).values({
      agentId,
      sessionId,
      turnsSinceMemoryReview: 9,
      lastReviewedMessageId: "previous-success",
      lastReviewedAt,
    });
    await resetReviewCadenceAfterEnqueue({ agentId, sessionId });
    const [state] = await getDb()
      .select()
      .from(agentReviewStates)
      .where(
        and(eq(agentReviewStates.agentId, agentId), eq(agentReviewStates.sessionId, sessionId)),
      );
    expect(state.turnsSinceMemoryReview).toBe(0);
    expect(state.lastReviewedMessageId).toBe("previous-success");
    expect(state.lastReviewedAt?.toISOString()).toBe(lastReviewedAt.toISOString());
  });

  it("short-circuits a redelivery from its committed receipt before any model call", async () => {
    const reviewKey = `receipt:${randomUUID()}`;
    const expected: RunTurnReviewResult = {
      proposalCount: 2,
      candidatesAccepted: 1,
      candidatesRejected: 0,
      candidatesProposed: 1,
      summary: "already committed",
      noActionReason: "",
    };
    await getDb().insert(agentReviewReceipts).values({
      agentId,
      reviewKey,
      extractorId: MEMORY_EXTRACTOR_ID,
      result: expected,
    });
    const actual = await runTurnReview({
      kind: "scheduled",
      agentId,
      taskId: randomUUID(),
      pgBossJobId: randomUUID(),
      attemptTraceId: randomUUID(),
      reviewKey,
    });
    expect(actual).toEqual(expected);
  });
});
