import type { UIMessage } from "ai";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { ScheduledTaskPayload } from "@/lib/scheduler/execute";
import type { ChatMessageMetadata } from "@/lib/token-usage";

// Column-level unions mirror the text+CHECK enums on the live tables; the
// CHECK constraints below are the database-side backstop for the same sets.
export type ScheduleType = "once" | "cron";
export type ScheduledTaskStatus = "active" | "paused" | "completed" | "cancelled";
export type ScheduledTaskRunStatus = "running" | "completed" | "failed" | "skipped";
export type SkillType = "skill" | "reference";
export type ChatMessageRole = "user" | "assistant" | "system";
export type MemoryKind = "preference" | "fact" | "correction" | "persona" | "episode" | "procedure";
export type MemoryType = "semantic" | "episodic" | "procedural";
export type MemoryConflictPolicy =
  | "replace_current"
  | "append_temporal"
  | "add_only"
  | "version_evaluate";
export type MemoryScopeType = "agent" | "session" | "task";
// `consolidated` is minted only by consolidation proposals (§1.1 source guard).
export type MemorySource = "user" | "review" | "curated" | "consolidated";
export type MemoryStatus = "creating" | "approved" | "archived";
export type TraceEventType =
  | "user_message"
  | "assistant_message"
  | "model_generation"
  | "tool_requested"
  | "tool_result"
  | "environment_observation"
  | "guardrail_result"
  | "feedback"
  | "decision_declared"
  | "outcome_observed"
  | "task_terminal_state"
  | "explicit_memory_write"
  | "legacy_import";
export type TraceActor = "user" | "assistant" | "tool" | "system" | "scheduler" | "worker";
export type TraceTrustClass =
  | "user_assertion"
  | "tool_observation"
  | "third_party_content"
  | "model_inference"
  | "evaluator_result"
  | "system_record";
export type SensitivityClass = "normal" | "sensitive" | "restricted";
export type TraceTerminalStatus = "completed" | "failed" | "interrupted" | "skipped";
export type TraceRetentionClass = "short" | "standard" | "audit";
export type CandidateSourceStance = "observation" | "assertion" | "interpretation" | "evaluation";
export type CandidateOperation = "ADD" | "UPDATE" | "INVALIDATE" | "NOOP" | "REVIEW";
export type CandidateGateStatus = "accepted" | "rejected" | "quarantined";
export type ReviewProposalKind =
  | "memory_create"
  | "memory_edit"
  | "memory_archive"
  | "skill_create"
  | "skill_edit"
  | "skill_toggle";
export type ReviewProposalStatus = "pending" | "rejected" | "applied" | "failed";
export type ReviewProposalPayload = Record<string, unknown>;
// A session is either a normal chat or a dedicated home session a scheduled
// task owns. The CHECK constraint on agent_chat_sessions is the DB-side backstop.
export type ChatSessionOrigin = "chat" | "scheduled_task";

// --- Memory consolidation (Appendix A.1) ---
// Who/what minted a proposal. `turn_review` is the existing per-turn reviewer;
// `consolidation`/`curator` are the new background proposers; `manual` is a human.
export type ReviewProposalOrigin = "manual" | "turn_review" | "consolidation" | "curator";
// How a pending proposal is admitted: human-gated by default, the narrow
// additive class may auto-apply, dry-run never lands.
export type AdmissionPolicy = "human_review" | "auto_apply_low_risk" | "dry_run_only";
// A grounded observation is sourced exclusively from user-authored content.
// `chat_user` = a user chat turn; `memory_user` = a source='user' memory.
export type GroundedObservationOrigin = "chat_user" | "memory_user";
export type ConsolidationRunStatus = "running" | "completed" | "failed";
export type ConsolidationTrigger = "scheduled" | "manual" | "turn_review";
// Append-only, human-readable timeline of how a memory evolved. Never read
// back into evidence.
export type MemoryEventType =
  | "created"
  | "edited"
  | "archived"
  | "protected"
  | "unprotected"
  | "proposed"
  | "applied"
  | "rejected"
  | "consolidation_run";
export type MemoryEventOrigin = "user" | "review" | "consolidation" | "curator";

// The score breakdown + gate results attached to a consolidation proposal so
// the review UI can render "why this was/wasn't proposed".
export type AdmissionMetadataV1 = {
  version: 1;
  origin: ReviewProposalOrigin;
  candidateId?: string;
  claimKey?: string;
  claimHash?: string;
  scoreBps?: number; // 0..10000
  score?: {
    relevanceBps: number;
    frequencyBps: number;
    diversityBps: number;
    recencyBps: number;
    consistencyBps: number;
    conceptBps: number;
    phaseBoostBps: number;
    totalBps: number;
  };
  gates?: {
    minScore: { passed: boolean; actualBps: number; thresholdBps: number };
    recallCount: { passed: boolean; actual: number; threshold: number };
    uniqueQueries: { passed: boolean; actual: number; threshold: number };
    maxAgeDays: { passed: boolean; actual: number; threshold: number };
    groundedEvidence: { passed: boolean; actual: number; threshold: 1 };
  };
  groundedObservationIds?: string[];
  autoApply?: { eligible: boolean; reasons: string[] };
  dryRun?: boolean;
};

export type AdmissionMetadataV2 = {
  version: 2;
  origin: ReviewProposalOrigin;
  sourceCandidateId: string;
  evidenceTraceEventIds: string[];
  memoryType: MemoryType;
  memoryKind: MemoryKind;
  proposedOperation: CandidateOperation;
  sourceStance: CandidateSourceStance;
  scoreBps: number;
  gateStatus: CandidateGateStatus;
  gateReason: string;
  canonicalKey?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  timePrecision?: "instant" | "day" | "month" | "year" | "unknown";
  dryRun?: boolean;
};

export type AdmissionMetadata = AdmissionMetadataV1 | AdmissionMetadataV2;

// agent_memory_events.detail — human-readable before/after + reason (e.g.
// "duplicate_claim_hash"). Never re-enters evidence.
export type MemoryEventDetail = {
  version: 1;
  before?: unknown;
  after?: unknown;
  admissionMetadata?: AdmissionMetadata;
  reason?: string;
};

// Per-agent scoring weights (stored in agent_consolidation_settings.weights).
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => "tstzrange",
});
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export type ConsolidationWeights = {
  relevance: number; // 0..1
  frequency: number;
  diversity: number;
  recency: number;
  consistency: number;
  concept: number;
  phaseLightBoost: number; // cap
  phaseRemBoost: number; // cap
  recencyHalfLifeDays: number;
};

export const agentScheduledTasks = pgTable(
  "agent_scheduled_tasks",
  {
    // No default: the app supplies the id (randomUUID) so it can register the
    // pg-boss job under the same id before the row is durably linked.
    id: uuid("id").primaryKey(),
    title: text("title").notNull(),
    payload: jsonb("payload").$type<ScheduledTaskPayload>().notNull(),
    scheduleType: text("schedule_type").$type<ScheduleType>().notNull(),
    runAt: timestamp("run_at", { withTimezone: true }),
    cron: text("cron"),
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status").$type<ScheduledTaskStatus>().notNull(),
    queueName: text("queue_name").notNull(),
    scheduleKey: text("schedule_key"),
    jobId: uuid("job_id"),
    // The chat that spawned this task, if any. Forward reference (thunk) because
    // agentChatSessions is declared later and the two tables reference each
    // other; both FK columns are nullable so no deferrable constraint is needed.
    originSessionId: uuid("origin_session_id").references((): AnyPgColumn => agentChatSessions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("agent_scheduled_tasks_schedule_type_check", sql`${t.scheduleType} in ('once', 'cron')`),
    check(
      "agent_scheduled_tasks_status_check",
      sql`${t.status} in ('active', 'paused', 'completed', 'cancelled')`,
    ),
    check(
      "agent_scheduled_tasks_check",
      sql`(${t.scheduleType} = 'once' and ${t.runAt} is not null) or (${t.scheduleType} = 'cron' and ${t.cron} is not null)`,
    ),
  ],
);

export const agentScheduledTaskRuns = pgTable(
  "agent_scheduled_task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => agentScheduledTasks.id),
    pgBossJobId: uuid("pg_boss_job_id").notNull(),
    status: text("status").$type<ScheduledTaskRunStatus>().notNull(),
    // Arbitrary tool output; left untyped (unknown) like the call sites treat it.
    output: jsonb("output"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("agent_scheduled_task_runs_pg_boss_job_id_key").on(t.pgBossJobId),
    check(
      "agent_scheduled_task_runs_status_check",
      sql`${t.status} in ('running', 'completed', 'failed', 'skipped')`,
    ),
    index("agent_scheduled_task_runs_task_id_idx").on(t.taskId, t.startedAt.desc()),
  ],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    // Self-referencing FK with no ON DELETE: a referenced parent cannot be
    // hard-deleted. Removal is soft-delete only (see deletedAt).
    parentId: uuid("parent_id").references((): AnyPgColumn => agentSkills.id),
    type: text("type").$type<SkillType>().notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => [
    check("agent_skills_type_check", sql`${t.type} in ('skill', 'reference')`),
    check("agent_skills_name_check", sql`char_length(${t.name}) between 1 and 64`),
    check("agent_skills_description_check", sql`char_length(${t.description}) between 1 and 1024`),
    check(
      "agent_skills_parent_shape",
      sql`(${t.type} = 'skill' and ${t.parentId} is null) or (${t.type} = 'reference' and ${t.parentId} is not null)`,
    ),
    // Skill names unique per agent; reference names unique within a parent.
    // Both partial — soft-deleted rows free their name for reuse.
    uniqueIndex("agent_skills_skill_name_uniq")
      .on(t.agentId, t.name)
      .where(sql`${t.type} = 'skill' and ${t.deletedAt} is null`),
    uniqueIndex("agent_skills_reference_name_uniq")
      .on(t.parentId, t.name)
      .where(sql`${t.type} = 'reference' and ${t.deletedAt} is null`),
    // Tier-1 catalog: an agent's enabled, live skills.
    index("agent_skills_catalog_idx")
      .on(t.agentId)
      .where(sql`${t.type} = 'skill' and ${t.isEnabled} = true and ${t.deletedAt} is null`),
    // Resolve a skill's live child references.
    index("agent_skills_parent_idx").on(t.parentId).where(sql`${t.deletedAt} is null`),
  ],
);

// Persisted chat conversations. Distinct from the in-page "sessionUsage" token
// term — this is the durable, reopenable transcript domain.
export const agentChatSessions = pgTable(
  "agent_chat_sessions",
  {
    // No default: the client supplies the id (crypto.randomUUID) so it can drive
    // useChat({ id }) before the first message is ever persisted.
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    // 'chat' for normal conversations, 'scheduled_task' for a dedicated home
    // session a task owns. CHECK below mirrors this enum.
    origin: text("origin").$type<ChatSessionOrigin>().notNull().default("chat"),
    // Set only on dedicated task sessions (origin = 'scheduled_task'); the task
    // whose rounds land here. Partial-unique: one dedicated session per task.
    taskId: uuid("task_id").references((): AnyPgColumn => agentScheduledTasks.id),
    // Null until the title model names it; the UI shows "New chat" meanwhile.
    title: text("title"),
    // Activity time for list ordering/grouping; distinct from updatedAt, which a
    // rename also bumps.
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => [
    check(
      "agent_chat_sessions_title_check",
      sql`${t.title} is null or char_length(${t.title}) between 1 and 200`,
    ),
    check("agent_chat_sessions_origin_check", sql`${t.origin} in ('chat', 'scheduled_task')`),
    // One dedicated session per task; partial so the many origin='chat' rows
    // (taskId null) don't collide.
    uniqueIndex("agent_chat_sessions_task_id_uniq")
      .on(t.taskId)
      .where(sql`${t.taskId} is not null`),
    // Sidebar list: an agent's live sessions. Ordering by
    // coalesce(last_message_at, created_at) desc happens in the query.
    index("agent_chat_sessions_list_idx").on(t.agentId).where(sql`${t.deletedAt} is null`),
  ],
);

export const agentChatMessages = pgTable(
  "agent_chat_messages",
  {
    // AI SDK message id (string; client-generated for user turns, server
    // generateMessageId for assistant turns). Not globally unique by design —
    // identity is per session via the composite primary key below.
    id: text("id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentChatSessions.id, { onDelete: "cascade" }),
    role: text("role").$type<ChatMessageRole>().notNull(),
    parts: jsonb("parts").$type<UIMessage<ChatMessageMetadata>["parts"]>().notNull(),
    metadata: jsonb("metadata").$type<ChatMessageMetadata>(),
    // Ordering only: equals the array index at save time. Deliberately NOT
    // unique — saveChatSession rewrites the whole transcript (delete-all then
    // insert) and reassigns ordinals, so a unique(session_id, ordinal) would
    // risk mid-write collisions on edit/regenerate.
    ordinal: integer("ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite identity: a message belongs to a session. A cross-session id
    // collision must not be fatal, and this suits delete-all-then-insert.
    primaryKey({ columns: [t.sessionId, t.id] }),
    check("agent_chat_messages_role_check", sql`${t.role} in ('user', 'assistant', 'system')`),
    index("agent_chat_messages_session_ordinal_idx").on(t.sessionId, t.ordinal),
  ],
);

export const agentTraceArtifacts = pgTable(
  "agent_trace_artifacts",
  {
    artifactHash: text("artifact_hash").primaryKey(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    encoding: text("encoding"),
    redactedExcerpt: text("redacted_excerpt").notNull(),
    content: bytea("content"),
    sensitivityClass: text("sensitivity_class").$type<SensitivityClass>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    check("agent_trace_artifacts_hash_check", sql`${t.artifactHash} ~ '^[0-9a-f]{64}$'`),
    check("agent_trace_artifacts_byte_size_check", sql`${t.byteSize} >= 0`),
    check("agent_trace_artifacts_excerpt_check", sql`char_length(${t.redactedExcerpt}) <= 4000`),
    check(
      "agent_trace_artifacts_content_check",
      sql`${t.content} is null or octet_length(${t.content}) <= 262144`,
    ),
    check(
      "agent_trace_artifacts_sensitivity_check",
      sql`${t.sensitivityClass} in ('normal', 'sensitive', 'restricted')`,
    ),
    index("agent_trace_artifacts_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

export const agentTraceEvents = pgTable(
  "agent_trace_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    traceId: text("trace_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    spanId: text("span_id"),
    parentEventId: uuid("parent_event_id").references((): AnyPgColumn => agentTraceEvents.id),
    sessionId: uuid("session_id"),
    taskId: uuid("task_id"),
    pgBossJobId: uuid("pg_boss_job_id"),
    sourceMessageId: text("source_message_id"),
    toolCallId: text("tool_call_id"),
    eventType: text("event_type").$type<TraceEventType>().notNull(),
    actor: text("actor").$type<TraceActor>().notNull(),
    trustClass: text("trust_class").$type<TraceTrustClass>().notNull(),
    sensitivityClass: text("sensitivity_class")
      .$type<SensitivityClass>()
      .notNull()
      .default("normal"),
    terminalStatus: text("terminal_status").$type<TraceTerminalStatus>(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    artifactHash: text("artifact_hash").references(() => agentTraceArtifacts.artifactHash),
    contentHash: text("content_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    retentionClass: text("retention_class").$type<TraceRetentionClass>().notNull(),
    policyVersion: text("policy_version").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    check("agent_trace_events_sequence_check", sql`${t.sequenceNo} >= 0`),
    check(
      "agent_trace_events_event_type_check",
      sql`${t.eventType} in ('user_message', 'assistant_message', 'model_generation', 'tool_requested', 'tool_result', 'environment_observation', 'guardrail_result', 'feedback', 'decision_declared', 'outcome_observed', 'task_terminal_state', 'explicit_memory_write', 'legacy_import')`,
    ),
    check(
      "agent_trace_events_actor_check",
      sql`${t.actor} in ('user', 'assistant', 'tool', 'system', 'scheduler', 'worker')`,
    ),
    check(
      "agent_trace_events_trust_check",
      sql`${t.trustClass} in ('user_assertion', 'tool_observation', 'third_party_content', 'model_inference', 'evaluator_result', 'system_record')`,
    ),
    check(
      "agent_trace_events_sensitivity_check",
      sql`${t.sensitivityClass} in ('normal', 'sensitive', 'restricted')`,
    ),
    check(
      "agent_trace_events_terminal_status_check",
      sql`${t.terminalStatus} is null or ${t.terminalStatus} in ('completed', 'failed', 'interrupted', 'skipped')`,
    ),
    check(
      "agent_trace_events_terminal_shape_check",
      sql`(${t.eventType} = 'task_terminal_state' and ${t.terminalStatus} is not null) or (${t.eventType} <> 'task_terminal_state' and ${t.terminalStatus} is null)`,
    ),
    check("agent_trace_events_payload_check", sql`octet_length(${t.payload}::text) <= 65536`),
    check(
      "agent_trace_events_idempotency_key_check",
      sql`char_length(${t.idempotencyKey}) between 1 and 256`,
    ),
    check(
      "agent_trace_events_retention_check",
      sql`${t.retentionClass} in ('short', 'standard', 'audit')`,
    ),
    unique("agent_trace_events_agent_idempotency_key").on(t.agentId, t.idempotencyKey),
    index("agent_trace_events_trace_sequence_idx").on(t.agentId, t.traceId, t.sequenceNo),
    index("agent_trace_events_session_ingested_idx")
      .on(t.sessionId, t.ingestedAt)
      .where(sql`${t.sessionId} is not null`),
    index("agent_trace_events_task_job_ingested_idx")
      .on(t.taskId, t.pgBossJobId, t.ingestedAt)
      .where(sql`${t.taskId} is not null`),
    index("agent_trace_events_type_occurred_idx").on(t.agentId, t.eventType, t.occurredAt),
    index("agent_trace_events_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} is not null`),
  ],
);

export const agentMemoryCandidates = pgTable(
  "agent_memory_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    reviewKey: text("review_key").notNull(),
    traceId: text("trace_id").notNull(),
    memoryType: text("memory_type").$type<MemoryType>().notNull(),
    canonicalKey: text("canonical_key"),
    content: text("content"),
    structured: jsonb("structured").$type<Record<string, unknown>>().notNull().default({}),
    sourceStance: text("source_stance").$type<CandidateSourceStance>().notNull(),
    validDuring: tstzrange("valid_during"),
    sourceReferenceTime: timestamp("source_reference_time", { withTimezone: true }),
    timePrecision: text("time_precision")
      .$type<"instant" | "day" | "month" | "year" | "unknown">()
      .notNull()
      .default("unknown"),
    confidence: integer("confidence").notNull(),
    proposedOperation: text("proposed_operation").$type<CandidateOperation>().notNull(),
    gateStatus: text("gate_status").$type<CandidateGateStatus>().notNull(),
    gateReason: text("gate_reason").notNull(),
    scoreBps: integer("score_bps").notNull(),
    contentHash: text("content_hash").notNull(),
    extractorId: text("extractor_id").notNull(),
    modelId: text("model_id").notNull(),
    promptHash: text("prompt_hash").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "agent_memory_candidates_memory_type_check",
      sql`${t.memoryType} in ('semantic', 'episodic', 'procedural')`,
    ),
    check(
      "agent_memory_candidates_source_stance_check",
      sql`${t.sourceStance} in ('observation', 'assertion', 'interpretation', 'evaluation')`,
    ),
    check(
      "agent_memory_candidates_time_precision_check",
      sql`${t.timePrecision} in ('instant', 'day', 'month', 'year', 'unknown')`,
    ),
    check("agent_memory_candidates_confidence_check", sql`${t.confidence} between 0 and 100`),
    check(
      "agent_memory_candidates_operation_check",
      sql`${t.proposedOperation} in ('ADD', 'UPDATE', 'INVALIDATE', 'NOOP', 'REVIEW')`,
    ),
    check(
      "agent_memory_candidates_gate_status_check",
      sql`${t.gateStatus} in ('accepted', 'rejected', 'quarantined')`,
    ),
    check("agent_memory_candidates_score_check", sql`${t.scoreBps} between 0 and 10000`),
    check(
      "agent_memory_candidates_content_shape_check",
      sql`(${t.gateStatus} = 'accepted' and char_length(${t.content}) between 1 and 2000) or (${t.gateStatus} in ('rejected', 'quarantined') and ${t.content} is null)`,
    ),
    unique("agent_memory_candidates_extract_uniq").on(
      t.agentId,
      t.reviewKey,
      t.extractorId,
      t.contentHash,
    ),
    index("agent_memory_candidates_gate_created_idx").on(t.agentId, t.gateStatus, t.createdAt),
    index("agent_memory_candidates_canonical_key_idx")
      .on(t.agentId, t.canonicalKey)
      .where(sql`${t.canonicalKey} is not null`),
  ],
);

export const agentMemoryCandidateTraceEvents = pgTable(
  "agent_memory_candidate_trace_events",
  {
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => agentMemoryCandidates.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => agentTraceEvents.id),
    sourceRole: text("source_role").$type<"primary" | "corroborating" | "context">().notNull(),
    sourceSpan: jsonb("source_span").$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.candidateId, t.eventId] }),
    check(
      "agent_memory_candidate_trace_events_role_check",
      sql`${t.sourceRole} in ('primary', 'corroborating', 'context')`,
    ),
    index("agent_memory_candidate_trace_events_event_idx").on(t.eventId),
  ],
);

export const agentDecisions = pgTable(
  "agent_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    sessionId: uuid("session_id"),
    taskId: uuid("task_id"),
    traceId: text("trace_id").notNull(),
    scopeType: text("scope_type").$type<MemoryScopeType>().notNull(),
    scopeId: text("scope_id").notNull(),
    subjectKey: text("subject_key").notNull(),
    selectedOption: text("selected_option").notNull(),
    declaredOptions: jsonb("declared_options").$type<string[]>().notNull().default([]),
    declaredRationale: text("declared_rationale").notNull(),
    assumptions: jsonb("assumptions").$type<string[]>().notNull().default([]),
    expectedOutcome: text("expected_outcome"),
    successCriteria: jsonb("success_criteria").$type<string[]>().notNull().default([]),
    constraints: jsonb("constraints").$type<string[]>().notNull().default([]),
    confidence: integer("confidence").notNull(),
    status: text("status")
      .$type<"open" | "succeeded" | "failed" | "mixed" | "superseded" | "unknown">()
      .notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    validDuring: tstzrange("valid_during"),
    recordedDuring: tstzrange("recorded_during").notNull(),
    decider: text("decider").notNull(),
    modelId: text("model_id"),
    promptHash: text("prompt_hash"),
    policyVersion: text("policy_version").notNull(),
    authority: text("authority")
      .$type<"user" | "worker" | "model_verdict" | "reviewed" | "legacy_import">()
      .notNull(),
    sensitivityClass: text("sensitivity_class")
      .$type<SensitivityClass>()
      .notNull()
      .default("normal"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tombstoned: boolean("tombstoned").notNull().default(false),
    injectionBlocked: boolean("injection_blocked").notNull().default(false),
    supersedesDecisionId: uuid("supersedes_decision_id").references(
      (): AnyPgColumn => agentDecisions.id,
    ),
  },
  (t) => [
    check("agent_decisions_scope_check", sql`${t.scopeType} in ('agent', 'session', 'task')`),
    check(
      "agent_decisions_rationale_check",
      sql`char_length(${t.declaredRationale}) between 1 and 2000`,
    ),
    check("agent_decisions_confidence_check", sql`${t.confidence} between 0 and 100`),
    check(
      "agent_decisions_status_check",
      sql`${t.status} in ('open', 'succeeded', 'failed', 'mixed', 'superseded', 'unknown')`,
    ),
    check(
      "agent_decisions_authority_check",
      sql`${t.authority} in ('user', 'worker', 'model_verdict', 'reviewed', 'legacy_import')`,
    ),
    check(
      "agent_decisions_sensitivity_check",
      sql`${t.sensitivityClass} in ('normal', 'sensitive', 'restricted')`,
    ),
    uniqueIndex("agent_decisions_supersedes_uniq")
      .on(t.supersedesDecisionId)
      .where(sql`${t.supersedesDecisionId} is not null`),
    index("agent_decisions_active_subject_idx")
      .on(t.agentId, t.scopeType, t.scopeId, t.subjectKey, t.status, t.decidedAt.desc())
      .where(
        sql`${t.status} <> 'superseded' and ${t.revokedAt} is null and ${t.tombstoned} = false and ${t.injectionBlocked} = false`,
      ),
    index("agent_decisions_task_status_idx")
      .on(t.taskId, t.status, t.decidedAt.desc())
      .where(sql`${t.taskId} is not null`),
    index("agent_decisions_valid_during_idx").using("gist", t.validDuring),
    index("agent_decisions_recorded_during_idx").using("gist", t.recordedDuring),
  ],
);

export const agentDecisionTraceEvents = pgTable(
  "agent_decision_trace_events",
  {
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => agentDecisions.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => agentTraceEvents.id),
    sourceRole: text("source_role").$type<"context" | "declaration" | "criterion">().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.decisionId, t.eventId] }),
    check(
      "agent_decision_trace_events_role_check",
      sql`${t.sourceRole} in ('context', 'declaration', 'criterion')`,
    ),
    index("agent_decision_trace_events_event_idx").on(t.eventId),
  ],
);

export const agentOutcomes = pgTable(
  "agent_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => agentDecisions.id),
    traceId: text("trace_id").notNull(),
    observedState: text("observed_state").notNull(),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    assessment: text("assessment").$type<"supports" | "contradicts" | "inconclusive">().notNull(),
    confidence: integer("confidence").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    evaluator: text("evaluator").notNull(),
    evaluatorVersion: text("evaluator_version"),
    policyVersion: text("policy_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "agent_outcomes_observed_state_check",
      sql`char_length(${t.observedState}) between 1 and 4000`,
    ),
    check(
      "agent_outcomes_assessment_check",
      sql`${t.assessment} in ('supports', 'contradicts', 'inconclusive')`,
    ),
    check("agent_outcomes_confidence_check", sql`${t.confidence} between 0 and 100`),
    index("agent_outcomes_decision_occurred_idx").on(t.decisionId, t.occurredAt.desc()),
    index("agent_outcomes_trace_occurred_idx").on(t.traceId, t.occurredAt),
  ],
);

export const agentOutcomeTraceEvents = pgTable(
  "agent_outcome_trace_events",
  {
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => agentOutcomes.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => agentTraceEvents.id),
    sourceRole: text("source_role").$type<"observation" | "metric" | "terminal_state">().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.outcomeId, t.eventId] }),
    check(
      "agent_outcome_trace_events_role_check",
      sql`${t.sourceRole} in ('observation', 'metric', 'terminal_state')`,
    ),
    index("agent_outcome_trace_events_event_idx").on(t.eventId),
  ],
);

export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    kind: text("kind").$type<MemoryKind>().notNull(),
    memoryType: text("memory_type").$type<MemoryType>().notNull().default("semantic"),
    canonicalKey: text("canonical_key"),
    conflictPolicy: text("conflict_policy")
      .$type<MemoryConflictPolicy>()
      .notNull()
      .default("append_temporal"),
    scopeType: text("scope_type").$type<MemoryScopeType>().notNull().default("agent"),
    scopeId: text("scope_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => agentMemoryVersions.id,
    ),
    // Human-approved memory proposals become live immediately; archive is the rollback path.
    status: text("status").$type<MemoryStatus>().notNull().default("approved"),
    sessionId: uuid("session_id").references(() => agentChatSessions.id, { onDelete: "set null" }),
    reviewProposalId: uuid("review_proposal_id").references(
      (): AnyPgColumn => agentReviewProposals.id,
      { onDelete: "set null" },
    ),
    // Normalized-content hash for dedupe/idempotency (§1.1). The partial unique
    // index on (agent_id, kind, claim_hash) is what prevents duplicate durable
    // facts and makes auto-apply races safe (§4.4).
    claimHash: text("claim_hash"),
    // Human "pin": consolidation and curator must never archive/edit a protected
    // row (§4.4 auto-apply predicate, §9.3 lock badge).
    isProtected: boolean("is_protected").notNull().default(false),
    protectedAt: timestamp("protected_at", { withTimezone: true }),
    protectedBy: text("protected_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tombstoned: boolean("tombstoned").notNull().default(false),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    injectionBlocked: boolean("injection_blocked").notNull().default(false),
  },
  (t) => [
    check(
      "agent_memories_kind_check",
      sql`${t.kind} in ('preference', 'fact', 'correction', 'persona', 'episode', 'procedure')`,
    ),
    check(
      "agent_memories_memory_type_check",
      sql`${t.memoryType} in ('semantic', 'episodic', 'procedural')`,
    ),
    check(
      "agent_memories_conflict_policy_check",
      sql`${t.conflictPolicy} in ('replace_current', 'append_temporal', 'add_only', 'version_evaluate')`,
    ),
    check("agent_memories_scope_type_check", sql`${t.scopeType} in ('agent', 'session', 'task')`),
    check("agent_memories_status_check", sql`${t.status} in ('creating', 'approved', 'archived')`),
    check(
      "agent_memories_current_version_shape_check",
      sql`(${t.status} = 'creating' and ${t.currentVersionId} is null) or (${t.status} <> 'creating' and ${t.currentVersionId} is not null)`,
    ),
    check(
      "agent_memories_tombstone_shape_check",
      sql`(${t.tombstoned} = true and ${t.tombstonedAt} is not null) or (${t.tombstoned} = false and ${t.tombstonedAt} is null)`,
    ),
    index("agent_memories_prompt_idx")
      .on(t.agentId, t.kind, t.createdAt)
      .where(
        sql`${t.status} = 'approved' and ${t.revokedAt} is null and ${t.tombstoned} = false and ${t.injectionBlocked} = false`,
      ),
    // Dedupe by durable identity. The index (not app logic) is what prevents
    // duplicate durable facts and makes auto-apply races safe (§4.4).
    uniqueIndex("agent_memories_claim_hash_uniq")
      .on(t.agentId, t.kind, t.claimHash)
      .where(
        sql`${t.claimHash} is not null and ${t.status} <> 'creating' and ${t.revokedAt} is null and ${t.tombstoned} = false`,
      ),
    index("agent_memories_active_current_idx")
      .on(t.agentId, t.scopeType, t.scopeId, t.memoryType, t.kind, t.status)
      .where(
        sql`${t.status} not in ('creating', 'archived') and ${t.revokedAt} is null and ${t.tombstoned} = false and ${t.injectionBlocked} = false`,
      ),
    uniqueIndex("agent_memories_canonical_key_uniq")
      .on(t.agentId, t.scopeType, t.scopeId, t.memoryType, t.canonicalKey)
      .where(
        sql`${t.canonicalKey} is not null and ${t.status} not in ('creating', 'archived') and ${t.revokedAt} is null and ${t.tombstoned} = false`,
      ),
  ],
);

export const agentMemoryVersions = pgTable(
  "agent_memory_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => agentMemories.id),
    versionNo: integer("version_no").notNull(),
    content: text("content").notNull(),
    structured: jsonb("structured").$type<Record<string, unknown>>().notNull().default({}),
    source: text("source").$type<MemorySource>().notNull(),
    validDuring: tstzrange("valid_during"),
    recordedDuring: tstzrange("recorded_during").notNull(),
    sourceReferenceTime: timestamp("source_reference_time", { withTimezone: true }),
    timePrecision: text("time_precision")
      .$type<"instant" | "day" | "month" | "year" | "unknown">()
      .notNull()
      .default("unknown"),
    timeSource: text("time_source"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    confidence: integer("confidence").notNull(),
    importance: integer("importance").notNull().default(50),
    utilityScoreBps: integer("utility_score_bps").notNull().default(0),
    operation: text("operation").$type<"ADD" | "UPDATE" | "INVALIDATE">().notNull(),
    supersedesMemoryVersionId: uuid("supersedes_memory_version_id").references(
      (): AnyPgColumn => agentMemoryVersions.id,
    ),
    extractorId: text("extractor_id"),
    modelId: text("model_id"),
    promptHash: text("prompt_hash"),
    schemaVersion: integer("schema_version").notNull().default(1),
    policyVersion: text("policy_version").notNull(),
    authority: text("authority")
      .$type<"user" | "tool" | "reviewed" | "consolidated" | "legacy_import">()
      .notNull(),
    sensitivityClass: text("sensitivity_class")
      .$type<SensitivityClass>()
      .notNull()
      .default("normal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce("content", ''))`,
    ),
  },
  (t) => [
    check("agent_memory_versions_version_check", sql`${t.versionNo} >= 1`),
    check("agent_memory_versions_content_check", sql`char_length(${t.content}) between 1 and 2000`),
    check(
      "agent_memory_versions_source_check",
      sql`${t.source} in ('user', 'review', 'curated', 'consolidated')`,
    ),
    check(
      "agent_memory_versions_time_precision_check",
      sql`${t.timePrecision} in ('instant', 'day', 'month', 'year', 'unknown')`,
    ),
    check("agent_memory_versions_confidence_check", sql`${t.confidence} between 0 and 100`),
    check("agent_memory_versions_importance_check", sql`${t.importance} between 0 and 100`),
    check(
      "agent_memory_versions_utility_score_check",
      sql`${t.utilityScoreBps} between 0 and 10000`,
    ),
    check(
      "agent_memory_versions_operation_check",
      sql`${t.operation} in ('ADD', 'UPDATE', 'INVALIDATE')`,
    ),
    check(
      "agent_memory_versions_authority_check",
      sql`${t.authority} in ('user', 'tool', 'reviewed', 'consolidated', 'legacy_import')`,
    ),
    check(
      "agent_memory_versions_sensitivity_check",
      sql`${t.sensitivityClass} in ('normal', 'sensitive', 'restricted')`,
    ),
    unique("agent_memory_versions_memory_version_uniq").on(t.memoryId, t.versionNo),
    uniqueIndex("agent_memory_versions_supersedes_uniq")
      .on(t.supersedesMemoryVersionId)
      .where(sql`${t.supersedesMemoryVersionId} is not null`),
    index("agent_memory_versions_search_tsv_idx").using("gin", t.searchTsv),
    index("agent_memory_versions_content_trgm_idx").using("gin", sql`${t.content} gin_trgm_ops`),
    index("agent_memory_versions_valid_during_idx").using("gist", t.validDuring),
    index("agent_memory_versions_recorded_during_idx").using("gist", t.recordedDuring),
    index("agent_memory_versions_memory_version_idx").on(t.memoryId, t.versionNo.desc()),
    index("agent_memory_versions_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

export const agentMemoryVersionTraceEvents = pgTable(
  "agent_memory_version_trace_events",
  {
    memoryVersionId: uuid("memory_version_id")
      .notNull()
      .references(() => agentMemoryVersions.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => agentTraceEvents.id),
    sourceRole: text("source_role").$type<"primary" | "corroborating" | "context">().notNull(),
    sourceSpan: jsonb("source_span").$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryVersionId, t.eventId] }),
    check(
      "agent_memory_version_trace_events_role_check",
      sql`${t.sourceRole} in ('primary', 'corroborating', 'context')`,
    ),
    index("agent_memory_version_trace_events_event_idx").on(t.eventId),
  ],
);

export const agentReviewProposals = pgTable(
  "agent_review_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    sessionId: uuid("session_id").references(() => agentChatSessions.id, { onDelete: "set null" }),
    triggerMessageId: text("trigger_message_id"),
    kind: text("kind").$type<ReviewProposalKind>().notNull(),
    payload: jsonb("payload").$type<ReviewProposalPayload>().notNull(),
    rationale: text("rationale").notNull(),
    status: text("status").$type<ReviewProposalStatus>().notNull().default("pending"),
    reviewerModel: text("reviewer_model"),
    sourceCandidateId: uuid("source_candidate_id").references(() => agentMemoryCandidates.id),
    // Who/what minted this proposal. Defaults to 'turn_review' so existing
    // per-turn reviewers keep their current behavior on backfill (§1.1).
    proposerOrigin: text("proposer_origin")
      .$type<ReviewProposalOrigin>()
      .notNull()
      .default("turn_review"),
    // How this proposal is admitted: human-gated by default. Only the narrow
    // additive class (§4.4) may be 'auto_apply_low_risk'; 'dry_run_only' never lands.
    admissionPolicy: text("admission_policy")
      .$type<AdmissionPolicy>()
      .notNull()
      .default("human_review"),
    // Score breakdown + gate results + evidence ids, rendered by the review UI
    // (§9.2 EvidenceDrawer). Typed shape: AdmissionMetadata (Appendix A.1).
    admissionMetadata: jsonb("admission_metadata").$type<AdmissionMetadata>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "agent_review_proposals_kind_check",
      sql`${t.kind} in ('memory_create', 'memory_edit', 'memory_archive', 'skill_create', 'skill_edit', 'skill_toggle')`,
    ),
    check(
      "agent_review_proposals_status_check",
      sql`${t.status} in ('pending', 'rejected', 'applied', 'failed')`,
    ),
    check(
      "agent_review_proposals_rationale_check",
      sql`char_length(${t.rationale}) between 1 and 2000`,
    ),
    check(
      "agent_review_proposals_proposer_origin_check",
      sql`${t.proposerOrigin} in ('manual', 'turn_review', 'consolidation', 'curator')`,
    ),
    check(
      "agent_review_proposals_admission_policy_check",
      sql`${t.admissionPolicy} in ('human_review', 'auto_apply_low_risk', 'dry_run_only')`,
    ),
    index("agent_review_proposals_pending_idx")
      .on(t.agentId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index("agent_review_proposals_session_idx").on(t.sessionId, t.createdAt),
    uniqueIndex("agent_review_proposals_source_candidate_uniq")
      .on(t.sourceCandidateId)
      .where(sql`${t.sourceCandidateId} is not null`),
  ],
);

export const agentReviewStates = pgTable(
  "agent_review_states",
  {
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentChatSessions.id, { onDelete: "cascade" }),
    turnsSinceMemoryReview: integer("turns_since_memory_review").notNull().default(0),
    lastReviewedMessageId: text("last_reviewed_message_id"),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.sessionId] }),
    check("agent_review_states_turns_check", sql`${t.turnsSinceMemoryReview} >= 0`),
  ],
);

// ============================================================================
// Memory consolidation (§1.2). All new tables are agent_-prefixed, partial-
// indexed, soft-deleted where rows are user-visible. Exact columns/types in
// Appendix A.4–A.9.
// ============================================================================

/**
 * The firewall (§4.1). One row per user-authored unit — a chat_user row points
 * at a user message; a memory_user row points at a source='user' memory.
 * Assistant/derivative content can never enter this table (role-gated single
 * writer, §3a), which is what makes "score your own output" structurally
 * impossible. The source-shape CHECK (not a WHERE clause) enforces which fields
 * each origin carries. sourceMessageId is text with no FK because
 * agent_chat_messages has a composite PK (session_id, id), so a single-column FK
 * is impossible. Dedupe is by source identity (unique per origin), NEVER by
 * content_hash — repeated user statements are real evidence and must each count.
 */
export const agentGroundedObservations = pgTable(
  "agent_grounded_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    // Chat provenance. NO FK: agent_chat_messages.id is text and not unique alone
    // (composite PK (session_id, id)).
    sessionId: uuid("session_id"),
    originKind: text("origin_kind").$type<GroundedObservationOrigin>().notNull(),
    sourceMessageId: text("source_message_id"),
    sourceMemoryId: uuid("source_memory_id").references(() => agentMemories.id),
    traceEventId: uuid("trace_event_id")
      .notNull()
      .references(() => agentTraceEvents.id),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "agent_grounded_observations_origin_kind_check",
      sql`${t.originKind} in ('chat_user', 'memory_user')`,
    ),
    check(
      "agent_grounded_observations_content_check",
      sql`char_length(${t.content}) between 1 and 2000`,
    ),
    // Source shape is enforced by a CHECK (not convention): a chat_user row must
    // carry session_id + source_message_id and no source_memory_id; a memory_user
    // row must carry source_memory_id and neither chat field (§1.2).
    check(
      "agent_grounded_observations_source_shape",
      sql`(${t.originKind} = 'chat_user' and ${t.sessionId} is not null and ${t.sourceMessageId} is not null and ${t.sourceMemoryId} is null) or (${t.originKind} = 'memory_user' and ${t.sourceMemoryId} is not null and ${t.sourceMessageId} is null)`,
    ),
    // Dedupe by source identity, not content. Repeated user statements each count.
    uniqueIndex("agent_grounded_observations_chat_uniq")
      .on(t.agentId, t.sessionId, t.sourceMessageId)
      .where(sql`${t.originKind} = 'chat_user' and ${t.deletedAt} is null`),
    uniqueIndex("agent_grounded_observations_memory_uniq")
      .on(t.agentId, t.sourceMemoryId)
      .where(sql`${t.originKind} = 'memory_user' and ${t.deletedAt} is null`),
    index("agent_grounded_observations_agent_created_idx")
      .on(t.agentId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
    index("agent_grounded_observations_trace_event_idx").on(t.traceEventId),
  ],
);

/**
 * Evidence accumulation (machine state, never in prompt). One row per normalized
 * claim, pointing back at the grounded observations that back it via an id list
 * (not hard FKs, so observation pruning never cascades into evidence — §1.3).
 * Scores are integer basis points (0..10000, §0.5).
 */
export const agentRecallSignals = pgTable(
  "agent_recall_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    claimKey: text("claim_key").notNull(),
    claimHash: text("claim_hash").notNull(),
    snippet: text("snippet").notNull(),
    // id list into agent_grounded_observations — NOT hard FKs (§1.3).
    groundedObservationIds: jsonb("grounded_observation_ids").$type<string[]>().notNull(),
    recallCount: integer("recall_count").notNull().default(0),
    uniqueQueryCount: integer("unique_query_count").notNull().default(0),
    queryHashes: jsonb("query_hashes").$type<string[]>().notNull().default([]),
    recallDays: jsonb("recall_days").$type<string[]>().notNull().default([]),
    conceptTags: jsonb("concept_tags").$type<string[]>().notNull().default([]),
    totalScoreBps: integer("total_score_bps").notNull().default(0),
    maxScoreBps: integer("max_score_bps").notNull().default(0),
    firstRecalledAt: timestamp("first_recalled_at", { withTimezone: true }),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedProposalId: uuid("promoted_proposal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("agent_recall_signals_score_check", sql`${t.totalScoreBps} between 0 and 10000`),
    check("agent_recall_signals_max_score_check", sql`${t.maxScoreBps} between 0 and 10000`),
    check("agent_recall_signals_recall_count_check", sql`${t.recallCount} >= 0`),
    check("agent_recall_signals_unique_query_count_check", sql`${t.uniqueQueryCount} >= 0`),
    uniqueIndex("agent_recall_signals_claim_uniq").on(t.agentId, t.claimHash),
    index("agent_recall_signals_agent_idx").on(t.agentId, t.lastRecalledAt),
  ],
);

/**
 * Bounded phase boosts (§4.2). Phase hits give a small capped boost only; they
 * can never satisfy the count/diversity gates alone. One row per agent+claim.
 */
export const agentPhaseSignals = pgTable(
  "agent_phase_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    claimKey: text("claim_key").notNull(),
    lightHits: integer("light_hits").notNull().default(0),
    remHits: integer("rem_hits").notNull().default(0),
    lastLightAt: timestamp("last_light_at", { withTimezone: true }),
    lastRemAt: timestamp("last_rem_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("agent_phase_signals_light_hits_check", sql`${t.lightHits} >= 0`),
    check("agent_phase_signals_rem_hits_check", sql`${t.remHits} >= 0`),
    uniqueIndex("agent_phase_signals_claim_uniq").on(t.agentId, t.claimKey),
  ],
);

/**
 * Incremental ingestion watermark (§1.2). Tuple checkpoints, not a single id,
 * because chat-message id is not globally unique (composite PK). Scans order by
 * (created_at, session_id, id) for chat and (created_at, id) for memories. One
 * row per agent (singleton via the default agent id).
 */
export const agentIngestionCheckpoints = pgTable("agent_ingestion_checkpoints", {
  agentId: uuid("agent_id").primaryKey().default("00000000-0000-0000-0000-000000000001"),
  lastChatMessageCreatedAt: timestamp("last_chat_message_created_at", { withTimezone: true }),
  lastChatSessionId: uuid("last_chat_session_id"),
  lastChatMessageId: text("last_chat_message_id"),
  lastMemoryCreatedAt: timestamp("last_memory_created_at", { withTimezone: true }),
  lastMemoryId: uuid("last_memory_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The two-state fix (§0.4, §3c). One snapshot per session (session_id UNIQUE).
 * The chat route renders from renderedBlock so the in-session prompt is frozen;
 * durable writes affect the NEXT session's snapshot.
 */
export const agentMemorySnapshots = pgTable(
  "agent_memory_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentChatSessions.id, { onDelete: "cascade" }),
    renderedBlock: text("rendered_block").notNull(),
    memoryIds: jsonb("memory_ids").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One snapshot per session — the freeze point.
    uniqueIndex("agent_memory_snapshots_session_uniq").on(t.sessionId),
  ],
);

/**
 * Per-agent operator config (§5). Mirrors env defaults, overridable in the
 * /consolidation UI. Thresholds stored as integers / basis points (§0.5).
 */
export const agentConsolidationSettings = pgTable(
  "agent_consolidation_settings",
  {
    agentId: uuid("agent_id").primaryKey().default("00000000-0000-0000-0000-000000000001"),
    enabled: boolean("enabled").notNull().default(false),
    autoApplyEnabled: boolean("auto_apply_enabled").notNull().default(false),
    dryRun: boolean("dry_run").notNull().default(true),
    minScoreBps: integer("min_score_bps").notNull().default(8000),
    minRecallCount: integer("min_recall_count").notNull().default(3),
    minUniqueQueries: integer("min_unique_queries").notNull().default(3),
    maxAgeDays: integer("max_age_days").notNull().default(30),
    weights: jsonb("weights").$type<ConsolidationWeights>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    check(
      "agent_consolidation_settings_min_score_check",
      sql`${t.minScoreBps} between 0 and 10000`,
    ),
    check("agent_consolidation_settings_min_recall_check", sql`${t.minRecallCount} >= 0`),
    check("agent_consolidation_settings_min_unique_queries_check", sql`${t.minUniqueQueries} >= 0`),
    check("agent_consolidation_settings_max_age_check", sql`${t.maxAgeDays} >= 0`),
  ],
);

/**
 * One row per sweep (§7). The run log: scanned/evaluated/passed/proposed
 * counters, duration, errors.
 */
export const agentConsolidationRuns = pgTable(
  "agent_consolidation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").$type<ConsolidationRunStatus>().notNull(),
    trigger: text("trigger").$type<ConsolidationTrigger>().notNull(),
    observationsScanned: integer("observations_scanned").notNull().default(0),
    candidatesEvaluated: integer("candidates_evaluated").notNull().default(0),
    candidatesPassed: integer("candidates_passed").notNull().default(0),
    proposalsCreated: integer("proposals_created").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    check(
      "agent_consolidation_runs_status_check",
      sql`${t.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      "agent_consolidation_runs_trigger_check",
      sql`${t.trigger} in ('scheduled', 'manual', 'turn_review')`,
    ),
    index("agent_consolidation_runs_agent_idx").on(t.agentId, t.startedAt),
  ],
);

/**
 * Per-run scored claims — the dry-run preview + explain-why surface (§7, §9.4).
 * scoreBps is basis points; gateResults carries the per-gate pass/fail; passed
 * is the overall verdict; proposalId links to the created review proposal if any.
 */
export const agentConsolidationCandidates = pgTable(
  "agent_consolidation_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentConsolidationRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    claimKey: text("claim_key").notNull(),
    snippet: text("snippet").notNull(),
    candidateOrigin: text("candidate_origin")
      .$type<"signal" | "turn_review">()
      .notNull()
      .default("signal"),
    sourceCandidateId: uuid("source_candidate_id").references(() => agentMemoryCandidates.id),
    memoryType: text("memory_type").$type<MemoryType>(),
    scoreBps: integer("score_bps").notNull(),
    gateResults: jsonb("gate_results").$type<AdmissionMetadataV1["gates"]>(),
    passed: boolean("passed").notNull(),
    proposalId: uuid("proposal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("agent_consolidation_candidates_score_check", sql`${t.scoreBps} between 0 and 10000`),
    check(
      "agent_consolidation_candidates_origin_check",
      sql`${t.candidateOrigin} in ('signal', 'turn_review')`,
    ),
    check(
      "agent_consolidation_candidates_memory_type_check",
      sql`${t.memoryType} is null or ${t.memoryType} in ('semantic', 'episodic', 'procedural')`,
    ),
    index("agent_consolidation_candidates_run_idx").on(t.runId),
    uniqueIndex("agent_consolidation_candidates_source_candidate_uniq")
      .on(t.sourceCandidateId)
      .where(sql`${t.sourceCandidateId} is not null`),
  ],
);

/**
 * The timeline / "see the evolution" feed (§7, §9.1). Append-only, human-
 * readable, and NEVER read back into evidence. Do not log memory_search usage
 * here (usage ≠ evolution).
 */
export const agentMemoryEvents = pgTable(
  "agent_memory_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    eventType: text("event_type").$type<MemoryEventType>().notNull(),
    memoryId: uuid("memory_id"),
    memoryVersionId: uuid("memory_version_id").references(() => agentMemoryVersions.id),
    proposalId: uuid("proposal_id"),
    runId: uuid("run_id"),
    origin: text("origin").$type<MemoryEventOrigin>().notNull(),
    summary: text("summary").notNull(),
    detail: jsonb("detail").$type<MemoryEventDetail>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "agent_memory_events_event_type_check",
      sql`${t.eventType} in ('created', 'edited', 'archived', 'protected', 'unprotected', 'proposed', 'applied', 'rejected', 'consolidation_run')`,
    ),
    check(
      "agent_memory_events_origin_check",
      sql`${t.origin} in ('user', 'review', 'consolidation', 'curator')`,
    ),
    index("agent_memory_events_agent_created_idx").on(t.agentId, t.createdAt),
    index("agent_memory_events_memory_idx").on(t.memoryId, t.createdAt),
  ],
);

export type AgentScheduledTask = typeof agentScheduledTasks.$inferSelect;
export type NewAgentScheduledTask = typeof agentScheduledTasks.$inferInsert;
export type AgentScheduledTaskRun = typeof agentScheduledTaskRuns.$inferSelect;
export type NewAgentScheduledTaskRun = typeof agentScheduledTaskRuns.$inferInsert;
export type AgentSkill = typeof agentSkills.$inferSelect;
export type NewAgentSkill = typeof agentSkills.$inferInsert;
export type AgentChatSession = typeof agentChatSessions.$inferSelect;
export type NewAgentChatSession = typeof agentChatSessions.$inferInsert;
export type AgentChatMessage = typeof agentChatMessages.$inferSelect;
export type NewAgentChatMessage = typeof agentChatMessages.$inferInsert;
export type AgentTraceArtifact = typeof agentTraceArtifacts.$inferSelect;
export type NewAgentTraceArtifact = typeof agentTraceArtifacts.$inferInsert;
export type AgentTraceEvent = typeof agentTraceEvents.$inferSelect;
export type NewAgentTraceEvent = typeof agentTraceEvents.$inferInsert;
export type AgentMemoryCandidate = typeof agentMemoryCandidates.$inferSelect;
export type NewAgentMemoryCandidate = typeof agentMemoryCandidates.$inferInsert;
export type AgentDecision = typeof agentDecisions.$inferSelect;
export type NewAgentDecision = typeof agentDecisions.$inferInsert;
export type AgentOutcome = typeof agentOutcomes.$inferSelect;
export type NewAgentOutcome = typeof agentOutcomes.$inferInsert;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type NewAgentMemory = typeof agentMemories.$inferInsert;
export type AgentMemoryVersion = typeof agentMemoryVersions.$inferSelect;
export type NewAgentMemoryVersion = typeof agentMemoryVersions.$inferInsert;
export type AgentReviewProposal = typeof agentReviewProposals.$inferSelect;
export type NewAgentReviewProposal = typeof agentReviewProposals.$inferInsert;
export type AgentReviewState = typeof agentReviewStates.$inferSelect;
export type NewAgentReviewState = typeof agentReviewStates.$inferInsert;
export type AgentGroundedObservation = typeof agentGroundedObservations.$inferSelect;
export type NewAgentGroundedObservation = typeof agentGroundedObservations.$inferInsert;
export type AgentRecallSignal = typeof agentRecallSignals.$inferSelect;
export type NewAgentRecallSignal = typeof agentRecallSignals.$inferInsert;
export type AgentPhaseSignal = typeof agentPhaseSignals.$inferSelect;
export type NewAgentPhaseSignal = typeof agentPhaseSignals.$inferInsert;
export type AgentIngestionCheckpoint = typeof agentIngestionCheckpoints.$inferSelect;
export type NewAgentIngestionCheckpoint = typeof agentIngestionCheckpoints.$inferInsert;
export type AgentMemorySnapshot = typeof agentMemorySnapshots.$inferSelect;
export type NewAgentMemorySnapshot = typeof agentMemorySnapshots.$inferInsert;
export type AgentConsolidationSettings = typeof agentConsolidationSettings.$inferSelect;
export type NewAgentConsolidationSettings = typeof agentConsolidationSettings.$inferInsert;
export type AgentConsolidationRun = typeof agentConsolidationRuns.$inferSelect;
export type NewAgentConsolidationRun = typeof agentConsolidationRuns.$inferInsert;
export type AgentConsolidationCandidate = typeof agentConsolidationCandidates.$inferSelect;
export type NewAgentConsolidationCandidate = typeof agentConsolidationCandidates.$inferInsert;
export type AgentMemoryEvent = typeof agentMemoryEvents.$inferSelect;
export type NewAgentMemoryEvent = typeof agentMemoryEvents.$inferInsert;
