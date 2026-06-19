import type { UIMessage } from "ai";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
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
export type MemoryKind = "preference" | "fact" | "correction" | "persona";
export type MemorySource = "user" | "review" | "curated";
export type MemoryStatus = "approved" | "archived";
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

export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().default("00000000-0000-0000-0000-000000000001"),
    kind: text("kind").$type<MemoryKind>().notNull(),
    content: text("content").notNull(),
    source: text("source").$type<MemorySource>().notNull(),
    // 0..100 keeps confidence sortable and avoids provider-specific float quirks.
    confidence: integer("confidence").notNull().default(100),
    // Human-approved memory proposals become live immediately; archive is the rollback path.
    status: text("status").$type<MemoryStatus>().notNull().default("approved"),
    sessionId: uuid("session_id").references(() => agentChatSessions.id, { onDelete: "set null" }),
    reviewProposalId: uuid("review_proposal_id").references(
      (): AnyPgColumn => agentReviewProposals.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "agent_memories_kind_check",
      sql`${t.kind} in ('preference', 'fact', 'correction', 'persona')`,
    ),
    check("agent_memories_source_check", sql`${t.source} in ('user', 'review', 'curated')`),
    check("agent_memories_status_check", sql`${t.status} in ('approved', 'archived')`),
    check("agent_memories_content_check", sql`char_length(${t.content}) between 1 and 2000`),
    check("agent_memories_confidence_check", sql`${t.confidence} between 0 and 100`),
    index("agent_memories_prompt_idx")
      .on(t.agentId, t.kind, t.createdAt)
      .where(sql`${t.status} = 'approved' and ${t.deletedAt} is null`),
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
    index("agent_review_proposals_pending_idx")
      .on(t.agentId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index("agent_review_proposals_session_idx").on(t.sessionId, t.createdAt),
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
export type AgentMemory = typeof agentMemories.$inferSelect;
export type NewAgentMemory = typeof agentMemories.$inferInsert;
export type AgentReviewProposal = typeof agentReviewProposals.$inferSelect;
export type NewAgentReviewProposal = typeof agentReviewProposals.$inferInsert;
export type AgentReviewState = typeof agentReviewStates.$inferSelect;
export type NewAgentReviewState = typeof agentReviewStates.$inferInsert;
