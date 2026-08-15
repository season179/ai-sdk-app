import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

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

  const artifactMap = new Map<string, TraceArtifactInput>();
  for (const event of events) {
    if (!event.artifact) continue;
    const prior = artifactMap.get(event.artifact.artifactHash);
    const priorExpiry = prior?.expiresAt ?? null;
    const nextExpiry = event.artifact.expiresAt ?? null;
    artifactMap.set(event.artifact.artifactHash, {
      ...(prior ?? event.artifact),
      // A deduplicated blob honors the strictest finite event retention.
      expiresAt:
        priorExpiry && nextExpiry
          ? new Date(Math.min(priorExpiry.getTime(), nextExpiry.getTime()))
          : (priorExpiry ?? nextExpiry),
    });
  }
  const artifacts = [...artifactMap.values()];
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
      .onConflictDoUpdate({
        target: agentTraceArtifacts.artifactHash,
        set: {
          expiresAt: sql`case
            when ${agentTraceArtifacts.expiresAt} is null then excluded.expires_at
            when excluded.expires_at is null then ${agentTraceArtifacts.expiresAt}
            else least(${agentTraceArtifacts.expiresAt}, excluded.expires_at)
          end`,
        },
      });
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

export async function assertPromotableTraceEvidence(
  input: { agentId: string; eventIds: string[] },
  db: AppDbClient = getDb(),
): Promise<AgentTraceEvent[]> {
  if (input.eventIds.length === 0) throw new Error("Trace evidence is required.");
  const rows = await db
    .select()
    .from(agentTraceEvents)
    .where(
      and(
        eq(agentTraceEvents.agentId, input.agentId),
        inArray(agentTraceEvents.id, [...new Set(input.eventIds)]),
      ),
    );
  if (rows.length !== new Set(input.eventIds).size) {
    throw new Error("Trace evidence is missing or foreign.");
  }
  const governed = rows.filter(
    (row) => !["explicit_memory_write", "legacy_import"].includes(row.eventType),
  );
  for (const traceId of new Set(governed.map((row) => row.traceId))) {
    const [terminal] = await db
      .select({ status: agentTraceEvents.terminalStatus })
      .from(agentTraceEvents)
      .where(
        and(
          eq(agentTraceEvents.agentId, input.agentId),
          eq(agentTraceEvents.traceId, traceId),
          eq(agentTraceEvents.eventType, "task_terminal_state"),
        ),
      )
      .orderBy(sql`${agentTraceEvents.sequenceNo} desc, ${agentTraceEvents.ingestedAt} desc`)
      .limit(1);
    if (terminal?.status !== "completed") {
      throw new Error("Trace evidence is not from a completed attempt.");
    }
  }
  return rows;
}

export async function listCompletedTraceWindow(
  input: {
    agentId: string;
    sessionId?: string;
    taskId?: string;
    since?: Date;
    expectedTraceId?: string;
  },
  db: AppDbClient = getDb(),
): Promise<AgentTraceEvent[]> {
  // Select traces by their terminal boundary, then fetch each selected trace in
  // full. A timestamp watermark can therefore never split an attempt, and a
  // tool-heavy trace is never truncated by a raw event-row limit.
  const terminals = await db
    .select()
    .from(agentTraceEvents)
    .where(
      and(
        eq(agentTraceEvents.agentId, input.agentId),
        input.sessionId ? eq(agentTraceEvents.sessionId, input.sessionId) : undefined,
        input.taskId ? eq(agentTraceEvents.taskId, input.taskId) : undefined,
        eq(agentTraceEvents.eventType, "task_terminal_state"),
        input.since
          ? or(
              sql`${agentTraceEvents.occurredAt} > ${input.since}`,
              input.expectedTraceId
                ? eq(agentTraceEvents.traceId, input.expectedTraceId)
                : undefined,
            )
          : undefined,
      ),
    )
    .orderBy(desc(agentTraceEvents.sequenceNo), desc(agentTraceEvents.ingestedAt));
  const latestByTrace = new Map<string, AgentTraceEvent>();
  for (const terminal of terminals) {
    if (!latestByTrace.has(terminal.traceId)) latestByTrace.set(terminal.traceId, terminal);
  }
  const traceIds = [...latestByTrace.values()]
    .filter((terminal) => terminal.terminalStatus === "completed")
    .map((terminal) => terminal.traceId);
  const rows: AgentTraceEvent[] = [];
  for (let offset = 0; offset < traceIds.length; offset += 100) {
    rows.push(
      ...(await db
        .select()
        .from(agentTraceEvents)
        .where(
          and(
            eq(agentTraceEvents.agentId, input.agentId),
            inArray(agentTraceEvents.traceId, traceIds.slice(offset, offset + 100)),
            input.sessionId ? eq(agentTraceEvents.sessionId, input.sessionId) : undefined,
            input.taskId ? eq(agentTraceEvents.taskId, input.taskId) : undefined,
          ),
        )),
    );
  }
  return rows.sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      a.sequenceNo - b.sequenceNo ||
      a.id.localeCompare(b.id),
  );
}
