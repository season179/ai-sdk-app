import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentDecisions,
  agentDecisionTraceEvents,
  agentOutcomes,
  agentOutcomeTraceEvents,
  agentTraceEvents,
} from "@/db/schema";
import { appendDecisionOutcome, recordScheduledDecision } from "@/lib/memory/decisions";
import { closePool, getPool } from "@/lib/scheduler/db";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("scheduled decisions ledger (integration)", () => {
  const agentId = randomUUID();
  const taskId = randomUUID();
  beforeAll(() => getPool());
  afterAll(async () => {
    const db = getDb();
    const decisions = await db
      .select({ id: agentDecisions.id })
      .from(agentDecisions)
      .where(eq(agentDecisions.agentId, agentId));
    for (const decision of decisions) {
      const outcomes = await db
        .select({ id: agentOutcomes.id })
        .from(agentOutcomes)
        .where(eq(agentOutcomes.decisionId, decision.id));
      for (const outcome of outcomes) {
        await db
          .delete(agentOutcomeTraceEvents)
          .where(eq(agentOutcomeTraceEvents.outcomeId, outcome.id));
      }
      await db.delete(agentOutcomes).where(eq(agentOutcomes.decisionId, decision.id));
      await db
        .delete(agentDecisionTraceEvents)
        .where(eq(agentDecisionTraceEvents.decisionId, decision.id));
    }
    await db.delete(agentDecisions).where(eq(agentDecisions.agentId, agentId));
    await db.delete(agentTraceEvents).where(eq(agentTraceEvents.agentId, agentId));
    await closePool();
  });

  it("records explicit verdict fields, supersession, and append-only outcomes", async () => {
    const first = await recordScheduledDecision({
      agentId,
      taskId,
      pgBossJobId: randomUUID(),
      traceId: randomUUID(),
      round: 1,
      retryCount: 0,
      selectedOption: "continue_chain",
      declaredRationale: "The monitored condition has not been met.",
      expectedOutcome: "Schedule another check.",
      successCriteria: ["A next round is queued"],
      modelId: "test/model",
    });
    expect(first.declaredRationale).toContain("condition");
    expect(first.successCriteria).toEqual(["A next round is queued"]);

    const outcome = await appendDecisionOutcome({
      agentId,
      decisionId: first.id,
      taskId,
      pgBossJobId: randomUUID(),
      traceId: first.traceId,
      round: 1,
      retryCount: 0,
      observedState: "Worker action: next_round_scheduled",
      assessment: "supports",
      status: "succeeded",
    });
    expect(outcome.assessment).toBe("supports");

    const second = await recordScheduledDecision({
      agentId,
      taskId,
      pgBossJobId: randomUUID(),
      traceId: randomUUID(),
      round: 2,
      retryCount: 0,
      selectedOption: "stop_chain",
      declaredRationale: "The monitored condition is now satisfied.",
      expectedOutcome: "Complete the task.",
      successCriteria: ["Task status becomes completed"],
    });
    expect(second.supersedesDecisionId).toBeNull();
    const history = await getDb()
      .select()
      .from(agentOutcomes)
      .where(eq(agentOutcomes.decisionId, first.id));
    expect(history).toHaveLength(1);
  });

  it("is idempotent for the same round and attempt", async () => {
    const input = {
      agentId,
      taskId,
      pgBossJobId: randomUUID(),
      traceId: randomUUID(),
      round: 99,
      retryCount: 1,
      selectedOption: "stop_chain",
      declaredRationale: "Idempotency check.",
      expectedOutcome: "No duplicate decision.",
      successCriteria: ["One row"],
    };
    const first = await recordScheduledDecision(input);
    const second = await recordScheduledDecision(input);
    expect(second.id).toBe(first.id);
  });
});
