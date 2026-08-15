import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  agentDecisions,
  agentDecisionTraceEvents,
  agentOutcomes,
  agentOutcomeTraceEvents,
  agentTraceEvents,
} from "@/db/schema";
import { buildTerminalEvent, type TraceContext } from "@/lib/memory/capture";
import { getMemoryPolicyVersion } from "@/lib/memory/config";
import { sanitizeTracePayload } from "@/lib/memory/redaction";
import { appendTraceEvents } from "@/lib/memory/trace";

export type ScheduledDecisionInput = {
  agentId: string;
  taskId: string;
  sessionId?: string | null;
  pgBossJobId: string;
  traceId: string;
  round: number;
  retryCount: number;
  selectedOption: string;
  declaredOptions?: string[];
  declaredRationale: string;
  assumptions?: string[];
  expectedOutcome?: string | null;
  successCriteria: string[];
  constraints?: string[];
  confidence?: number;
  modelId?: string | null;
  promptHash?: string | null;
  occurredAt?: Date;
};

export async function recordScheduledDecision(
  input: ScheduledDecisionInput,
  outerDb?: AppDbClient,
) {
  const run = async (db: AppDbClient) => {
    const key = `task:${input.taskId}:round:${input.round}:attempt:${input.retryCount}:decision`;
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const payload = sanitizeTracePayload({
      subject: `scheduled-task:${input.taskId}`,
      selectedOption: input.selectedOption,
      declaredRationale: input.declaredRationale,
      expectedOutcome: input.expectedOutcome ?? null,
      successCriteria: input.successCriteria,
    });
    const [traceEvent] = await appendTraceEvents(
      [
        {
          agentId: input.agentId,
          traceId: input.traceId,
          sequenceNo: 999_990,
          sessionId: input.sessionId ?? null,
          taskId: input.taskId,
          pgBossJobId: input.pgBossJobId,
          eventType: "decision_declared",
          actor: "worker",
          trustClass: "evaluator_result",
          payload: payload.payload,
          contentHash: payload.contentHash,
          artifact: payload.artifact,
          sensitivityClass: payload.sensitivityClass,
          idempotencyKey: key,
          retentionClass: "audit",
          occurredAt: input.occurredAt ?? new Date(),
        },
      ],
      db,
    );

    const [existing] = await db
      .select({ decision: agentDecisions })
      .from(agentDecisionTraceEvents)
      .innerJoin(agentDecisions, eq(agentDecisions.id, agentDecisionTraceEvents.decisionId))
      .where(eq(agentDecisionTraceEvents.eventId, traceEvent.id))
      .limit(1);
    if (existing) return existing.decision;

    const [previous] = await db
      .select()
      .from(agentDecisions)
      .where(
        and(
          eq(agentDecisions.agentId, input.agentId),
          eq(agentDecisions.scopeType, "task"),
          eq(agentDecisions.scopeId, input.taskId),
          eq(agentDecisions.subjectKey, `scheduled-task:${input.taskId}`),
          inArray(agentDecisions.status, ["open", "unknown"]),
          isNull(agentDecisions.revokedAt),
          eq(agentDecisions.tombstoned, false),
        ),
      )
      .orderBy(desc(agentDecisions.decidedAt))
      .limit(1);

    if (previous) {
      await db
        .update(agentDecisions)
        .set({ status: "superseded" })
        .where(eq(agentDecisions.id, previous.id));
    }

    const now = input.occurredAt ?? new Date();
    const [decision] = await db
      .insert(agentDecisions)
      .values({
        agentId: input.agentId,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId,
        traceId: input.traceId,
        scopeType: "task",
        scopeId: input.taskId,
        subjectKey: `scheduled-task:${input.taskId}`,
        selectedOption: input.selectedOption,
        declaredOptions: input.declaredOptions ?? [],
        declaredRationale: input.declaredRationale.trim().slice(0, 2000),
        assumptions: input.assumptions ?? [],
        expectedOutcome: input.expectedOutcome ?? null,
        successCriteria: input.successCriteria,
        constraints: input.constraints ?? [],
        confidence: input.confidence ?? 80,
        status: "open",
        decidedAt: now,
        recordedDuring: sql`tstzrange(${now}, NULL, '[)')`,
        decider: "scheduled-instruction-verdict",
        modelId: input.modelId ?? null,
        promptHash: input.promptHash ?? null,
        policyVersion: getMemoryPolicyVersion(),
        authority: "model_verdict",
        supersedesDecisionId: previous?.id ?? null,
      })
      .returning();
    await db
      .insert(agentDecisionTraceEvents)
      .values({ decisionId: decision.id, eventId: traceEvent.id, sourceRole: "declaration" });
    return decision;
  };

  if (outerDb) return run(outerDb);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '750ms'`);
    return run(tx);
  });
}

export type DecisionOutcomeInput = {
  agentId: string;
  decisionId: string;
  taskId: string;
  pgBossJobId: string;
  traceId: string;
  round: number;
  retryCount: number;
  observedState: string;
  assessment: "supports" | "contradicts" | "inconclusive";
  confidence?: number;
  metrics?: Record<string, unknown>;
  status: "succeeded" | "failed" | "mixed" | "unknown";
  terminalEventId?: string;
  occurredAt?: Date;
};

export async function appendDecisionOutcome(input: DecisionOutcomeInput, outerDb?: AppDbClient) {
  const run = async (db: AppDbClient) => {
    const key = `task:${input.taskId}:round:${input.round}:attempt:${input.retryCount}:outcome`;
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const payload = sanitizeTracePayload({
      observedState: input.observedState,
      assessment: input.assessment,
      metrics: input.metrics ?? {},
    });
    const [traceEvent] = await appendTraceEvents(
      [
        {
          agentId: input.agentId,
          traceId: input.traceId,
          sequenceNo: 999_995,
          taskId: input.taskId,
          pgBossJobId: input.pgBossJobId,
          eventType: "outcome_observed",
          actor: "worker",
          trustClass: "evaluator_result",
          payload: payload.payload,
          contentHash: payload.contentHash,
          idempotencyKey: key,
          retentionClass: "audit",
          occurredAt: input.occurredAt ?? new Date(),
        },
      ],
      db,
    );
    const [existing] = await db
      .select({ outcome: agentOutcomes })
      .from(agentOutcomeTraceEvents)
      .innerJoin(agentOutcomes, eq(agentOutcomes.id, agentOutcomeTraceEvents.outcomeId))
      .where(eq(agentOutcomeTraceEvents.eventId, traceEvent.id))
      .limit(1);
    if (existing) return existing.outcome;

    const [decision] = await db
      .select()
      .from(agentDecisions)
      .where(
        and(eq(agentDecisions.id, input.decisionId), eq(agentDecisions.agentId, input.agentId)),
      )
      .limit(1);
    if (!decision) throw new Error("Decision outcome requires a same-agent decision.");

    const [outcome] = await db
      .insert(agentOutcomes)
      .values({
        decisionId: input.decisionId,
        traceId: input.traceId,
        observedState: input.observedState.trim().slice(0, 4000),
        metrics: input.metrics ?? {},
        assessment: input.assessment,
        confidence: input.confidence ?? 90,
        occurredAt: input.occurredAt ?? new Date(),
        evaluator: "scheduled-task-worker",
        evaluatorVersion: "write-v1",
        policyVersion: getMemoryPolicyVersion(),
      })
      .returning();
    const eventIds = [traceEvent.id];
    if (input.terminalEventId) {
      const [terminal] = await db
        .select({ id: agentTraceEvents.id })
        .from(agentTraceEvents)
        .where(
          and(
            eq(agentTraceEvents.id, input.terminalEventId),
            eq(agentTraceEvents.agentId, input.agentId),
            eq(agentTraceEvents.traceId, input.traceId),
          ),
        );
      if (!terminal) throw new Error("Outcome terminal evidence is missing or foreign.");
      eventIds.push(terminal.id);
    }
    await db.insert(agentOutcomeTraceEvents).values(
      eventIds.map((eventId, index) => ({
        outcomeId: outcome.id,
        eventId,
        sourceRole: index === 0 ? ("observation" as const) : ("terminal_state" as const),
      })),
    );
    await db
      .update(agentDecisions)
      .set({ status: input.status })
      .where(eq(agentDecisions.id, input.decisionId));
    return outcome;
  };
  if (outerDb) return run(outerDb);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '750ms'`);
    return run(tx);
  });
}

/** Convenience for failed scheduled attempts that still need terminal evidence. */
export async function appendFailedAttemptTerminal(context: TraceContext, message: string) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '750ms'`);
    return appendTraceEvents([buildTerminalEvent(context, "failed", { error: message })], tx);
  });
}
