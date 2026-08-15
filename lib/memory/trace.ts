import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  type AgentTraceEvent,
  agentTraceArtifacts,
  agentTraceEvents,
  type SensitivityClass,
  type TraceActor,
  type TraceEventType,
  type TraceRetentionClass,
  type TraceTerminalStatus,
  type TraceTrustClass,
} from "@/db/schema";
import { getMemoryPolicyVersion, isMemoryWriteEnabled } from "@/lib/memory/config";
import type { TraceArtifactInput } from "@/lib/memory/redaction";

export type TraceEventInput = {
  agentId: string;
  traceId: string;
  sequenceNo: number;
  spanId?: string | null;
  parentEventId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  pgBossJobId?: string | null;
  sourceMessageId?: string | null;
  toolCallId?: string | null;
  eventType: TraceEventType;
  actor: TraceActor;
  trustClass: TraceTrustClass;
  sensitivityClass?: SensitivityClass;
  terminalStatus?: TraceTerminalStatus | null;
  payload: Record<string, unknown>;
  artifact?: TraceArtifactInput;
  contentHash: string;
  idempotencyKey: string;
  retentionClass: TraceRetentionClass;
  policyVersion?: string;
  occurredAt: Date;
  expiresAt?: Date | null;
};

function validateEvent(event: TraceEventInput): void {
  if (!event.idempotencyKey || event.idempotencyKey.length > 256) {
    throw new Error("Trace idempotency keys must contain 1..256 characters.");
  }
  if (!Number.isInteger(event.sequenceNo) || event.sequenceNo < 0) {
    throw new Error("Trace sequence numbers must be non-negative integers.");
  }
  if ((event.eventType === "task_terminal_state") !== Boolean(event.terminalStatus)) {
    throw new Error("Only terminal trace events may carry terminalStatus, and they must carry it.");
  }
}

export async function appendTraceEvents(
  events: TraceEventInput[],
  db: AppDbClient = getDb(),
): Promise<AgentTraceEvent[]> {
  if (events.length === 0) return [];
  events.forEach(validateEvent);

  const artifacts = [...new Map(events.flatMap((event) => (event.artifact ? [[event.artifact.artifactHash, event.artifact] as const] : []))).values()];
  if (artifacts.length > 0) {
    await db
      .insert(agentTraceArtifacts)
      .values(
        artifacts.map((artifact) => ({
          artifactHash: artifact.artifactHash,
          mediaType: artifact.mediaType,
          byteSize: artifact.byteSize,
          encoding: artifact.encoding,
          redactedExcerpt: artifact.redactedExcerpt,
          content: artifact.content,
          sensitivityClass: artifact.sensitivityClass,
          expiresAt: artifact.expiresAt ?? null,
        })),
      )
      .onConflictDoNothing();
  }

  await db
    .insert(agentTraceEvents)
    .values(
      events.map((event) => ({
        agentId: event.agentId,
        traceId: event.traceId,
        sequenceNo: event.sequenceNo,
        spanId: event.spanId ?? null,
        parentEventId: event.parentEventId ?? null,
        sessionId: event.sessionId ?? null,
        taskId: event.taskId ?? null,
        pgBossJobId: event.pgBossJobId ?? null,
        sourceMessageId: event.sourceMessageId ?? null,
        toolCallId: event.toolCallId ?? null,
        eventType: event.eventType,
        actor: event.actor,
        trustClass: event.trustClass,
        sensitivityClass: event.sensitivityClass ?? event.artifact?.sensitivityClass ?? "normal",
        terminalStatus: event.terminalStatus ?? null,
        payload: event.payload,
        artifactHash: event.artifact?.artifactHash ?? null,
        contentHash: event.contentHash,
        idempotencyKey: event.idempotencyKey,
        retentionClass: event.retentionClass,
        policyVersion: event.policyVersion ?? getMemoryPolicyVersion(),
        occurredAt: event.occurredAt,
        expiresAt: event.expiresAt ?? null,
      })),
    )
    .onConflictDoNothing({ target: [agentTraceEvents.agentId, agentTraceEvents.idempotencyKey] });

  return db
    .select()
    .from(agentTraceEvents)
    .where(
      and(
        eq(agentTraceEvents.agentId, events[0].agentId),
        inArray(
          agentTraceEvents.idempotencyKey,
          events.map((event) => event.idempotencyKey),
        ),
      ),
    )
    .orderBy(asc(agentTraceEvents.sequenceNo));
}

export async function appendTraceEventsFailOpen(
  events: TraceEventInput[],
  outerDb?: AppDbClient,
): Promise<AgentTraceEvent[]> {
  if (!isMemoryWriteEnabled() || events.length === 0) return [];
  try {
    if (outerDb) {
      return await outerDb.transaction(async (savepoint) => {
        await savepoint.execute(sql`set local statement_timeout = '750ms'`);
        const rows = await appendTraceEvents(events, savepoint);
        await savepoint.execute(sql`set local statement_timeout = 0`);
        return rows;
      });
    }
    return await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '750ms'`);
      return appendTraceEvents(events, tx);
    });
  } catch (error) {
    console.error("Agent trace capture failed; continuing without journal evidence", error);
    return [];
  }
}

export type TraceWindowScope = {
  agentId: string;
  eventIds: string[];
  traceIds?: string[];
  sessionId?: string;
  taskId?: string;
};

export async function assertCompletedTraceWindow(
  scope: TraceWindowScope,
  db: AppDbClient = getDb(),
): Promise<AgentTraceEvent[]> {
  if (scope.eventIds.length === 0) throw new Error("Trace evidence is required.");
  const rows = await db
    .select()
    .from(agentTraceEvents)
    .where(
      and(
        eq(agentTraceEvents.agentId, scope.agentId),
        inArray(agentTraceEvents.id, scope.eventIds),
        scope.sessionId ? eq(agentTraceEvents.sessionId, scope.sessionId) : undefined,
        scope.taskId ? eq(agentTraceEvents.taskId, scope.taskId) : undefined,
      ),
    );
  if (rows.length !== new Set(scope.eventIds).size) {
    throw new Error("Trace evidence contains unknown, foreign, or outside-window event ids.");
  }
  if (scope.traceIds && rows.some((row) => !scope.traceIds?.includes(row.traceId))) {
    throw new Error("Trace evidence falls outside the allowed review traces.");
  }

  const traceIds = [...new Set(rows.map((row) => row.traceId))];
  for (const traceId of traceIds) {
    const [terminal] = await db
      .select()
      .from(agentTraceEvents)
      .where(
        and(
          eq(agentTraceEvents.agentId, scope.agentId),
          eq(agentTraceEvents.traceId, traceId),
          eq(agentTraceEvents.eventType, "task_terminal_state"),
        ),
      )
      .orderBy(sql`${agentTraceEvents.sequenceNo} desc, ${agentTraceEvents.ingestedAt} desc`)
      .limit(1);
    if (!terminal || terminal.terminalStatus !== "completed") {
      throw new Error("Trace review window is incomplete.");
    }
  }
  return rows;
}

export async function listCompletedTraceWindow(
  input: { agentId: string; sessionId?: string; taskId?: string; since?: Date },
  db: AppDbClient = getDb(),
): Promise<AgentTraceEvent[]> {
  const rows = await db
    .select()
    .from(agentTraceEvents)
    .where(
      and(
        eq(agentTraceEvents.agentId, input.agentId),
        input.sessionId ? eq(agentTraceEvents.sessionId, input.sessionId) : undefined,
        input.taskId ? eq(agentTraceEvents.taskId, input.taskId) : undefined,
        input.since ? sql`${agentTraceEvents.occurredAt} > ${input.since}` : undefined,
      ),
    )
    .orderBy(asc(agentTraceEvents.occurredAt), asc(agentTraceEvents.sequenceNo))
    .limit(500);

  const completed = new Set(
    rows
      .filter((row) => row.eventType === "task_terminal_state" && row.terminalStatus === "completed")
      .map((row) => row.traceId),
  );
  const incomplete = new Set(
    rows
      .filter(
        (row) =>
          row.eventType === "task_terminal_state" && row.terminalStatus !== "completed",
      )
      .map((row) => row.traceId),
  );
  return rows.filter((row) => completed.has(row.traceId) && !incomplete.has(row.traceId));
}
