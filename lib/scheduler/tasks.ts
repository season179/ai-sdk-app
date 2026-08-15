import { randomUUID } from "node:crypto";

import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import { agentChatSessions, agentScheduledTaskRuns, agentScheduledTasks } from "@/db/schema";
import { createTaskSession } from "@/lib/chat/sessions";
import {
  getBoss,
  TASK_QUEUE_NAME,
  taskScheduleOptions,
  taskSendOptions,
} from "@/lib/scheduler/boss";
import { parseCronExpression } from "@/lib/scheduler/cron";
import { getDefaultScheduleTimezone } from "@/lib/scheduler/env";
import {
  clampChainDelaySeconds,
  parseScheduledTaskPayload,
  type ScheduledTaskPayload,
} from "@/lib/scheduler/execute";

export type ScheduledTaskStatus = "active" | "paused" | "completed" | "cancelled";

export type ScheduledTaskRunStatus = "running" | "completed" | "failed" | "skipped";

export type ScheduledTaskLastRun = {
  status: ScheduledTaskRunStatus;
  startedAt: string;
  completedAt: string | null;
  output: unknown;
  error: string | null;
};

export type ScheduledTask = {
  id: string;
  title: string;
  payload: ScheduledTaskPayload;
  scheduleType: "once" | "cron";
  runAt: string | null;
  cron: string | null;
  timezone: string;
  status: ScheduledTaskStatus;
  jobId: string | null;
  /** The chat that spawned this task, if any (null for standalone tasks). */
  originSessionId: string | null;
  /**
   * Where this task's rounds are appended: the originating chat if it has one,
   * else the dedicated session the task owns. Null only for legacy tasks created
   * before sessions existed (no origin and no dedicated session).
   */
  homeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: ScheduledTaskLastRun | null;
};

export type ScheduledTaskRun = {
  id: string;
  taskId: string;
  status: ScheduledTaskRunStatus;
  output: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type CreateScheduledTaskInput = {
  title: string;
  payload: unknown;
  scheduleType: "once" | "cron";
  /** ISO 8601 timestamp; required when scheduleType is 'once'. */
  runAt?: string;
  /** Cron expression; required when scheduleType is 'cron'. */
  cron?: string;
  /** IANA timezone for cron evaluation. Defaults to DEFAULT_SCHEDULE_TIMEZONE. */
  timezone?: string;
  /**
   * The chat session that spawned this task. When set, rounds append into that
   * chat; when omitted, createScheduledTask mints a dedicated home session.
   */
  originSessionId?: string;
};

export class SchedulerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerInputError";
  }
}

export class ScheduledTaskNotFoundError extends SchedulerInputError {
  constructor(id: string) {
    super(`No scheduled task with id '${id}' was found.`);
    this.name = "ScheduledTaskNotFoundError";
  }
}

// Table columns come from $inferSelect; the last-run fields are joined in by
// listScheduledTasks (and absent on the single-row reads, hence optional).
// dedicatedSessionId is the id of the session the task owns (origin =
// 'scheduled_task'), left-joined on every read so mapTaskRow can resolve the
// home session without a second query.
type TaskRow = typeof agentScheduledTasks.$inferSelect & {
  dedicatedSessionId?: string | null;
  lastRunStatus?: ScheduledTaskRunStatus | null;
  lastRunStartedAt?: Date | null;
  lastRunCompletedAt?: Date | null;
  lastRunOutput?: unknown;
  lastRunError?: string | null;
};

export async function createScheduledTask(input: CreateScheduledTaskInput) {
  const title = input.title?.trim();

  if (!title) {
    throw new SchedulerInputError("Task title is required.");
  }

  const payload = parseScheduledTaskPayload(input.payload);
  const id = randomUUID();
  const db = getDb();
  const boss = await getBoss();

  if (input.scheduleType === "once") {
    const runAt = parseRunAt(input.runAt);

    await db.insert(agentScheduledTasks).values({
      id,
      title,
      payload,
      scheduleType: "once",
      runAt,
      timezone: "UTC",
      status: "active",
      queueName: TASK_QUEUE_NAME,
      originSessionId: input.originSessionId ?? null,
    });

    try {
      const jobId = await boss.sendAfter(
        TASK_QUEUE_NAME,
        { taskId: id },
        taskSendOptions(id),
        runAt,
      );

      if (!jobId) {
        throw new Error("pg-boss did not return a job id for the scheduled task.");
      }

      await db
        .update(agentScheduledTasks)
        .set({ jobId, updatedAt: sql`now()` })
        .where(eq(agentScheduledTasks.id, id));
    } catch (error) {
      await db.delete(agentScheduledTasks).where(eq(agentScheduledTasks.id, id));
      throw error;
    }
  } else if (input.scheduleType === "cron") {
    const cron = input.cron?.trim();

    if (!cron) {
      throw new SchedulerInputError("A cron expression is required for recurring tasks.");
    }

    const timezone = parseTimezone(input.timezone);
    parseCron(cron, timezone);

    await db.insert(agentScheduledTasks).values({
      id,
      title,
      payload,
      scheduleType: "cron",
      cron,
      timezone,
      status: "active",
      queueName: TASK_QUEUE_NAME,
      scheduleKey: id,
      originSessionId: input.originSessionId ?? null,
    });

    try {
      await boss.schedule(TASK_QUEUE_NAME, cron, { taskId: id }, taskScheduleOptions(id, timezone));
    } catch (error) {
      await db.delete(agentScheduledTasks).where(eq(agentScheduledTasks.id, id));
      throw error;
    }
  } else {
    throw new SchedulerInputError("scheduleType must be 'once' or 'cron'.");
  }

  // A task spawned from a chat lives in that chat; a standalone task (API / tasks
  // UI) gets its own dedicated home session. Created after the boss job is wired
  // so a scheduling failure (which deletes the task) never strands a session
  // whose FK would block the rollback delete.
  if (!input.originSessionId) {
    await createTaskSession(id, title);
  }

  return requireScheduledTask(id);
}

export async function cancelScheduledTask(id: string) {
  const task = await requireScheduledTask(id);

  if (task.status === "cancelled") {
    return task;
  }

  if (task.status === "completed") {
    throw new SchedulerInputError("This task already completed; there is nothing to cancel.");
  }

  if (task.status === "active") {
    await detachFromBoss(task);
  }

  await updateTaskStatus(id, "cancelled");

  return requireScheduledTask(id);
}

export async function pauseScheduledTask(id: string) {
  const task = await requireScheduledTask(id);

  if (task.status !== "active") {
    throw new SchedulerInputError(`Only active tasks can be paused. This task is ${task.status}.`);
  }

  await detachFromBoss(task);
  await updateTaskStatus(id, "paused");

  return requireScheduledTask(id);
}

export async function resumeScheduledTask(id: string) {
  const task = await requireScheduledTask(id);

  if (task.status !== "paused") {
    throw new SchedulerInputError(`Only paused tasks can be resumed. This task is ${task.status}.`);
  }

  const boss = await getBoss();

  if (task.scheduleType === "cron") {
    if (!task.cron) {
      throw new SchedulerInputError("This recurring task has no cron expression.");
    }

    await boss.schedule(
      TASK_QUEUE_NAME,
      task.cron,
      { taskId: id },
      taskScheduleOptions(id, task.timezone),
    );
    await updateTaskStatus(id, "active");
  } else {
    // Self-chaining instruction tasks have no meaningful run_at once the chain
    // is moving: resume picks the chain back up after one cadence delay.
    const runAt =
      task.payload.kind === "instruction"
        ? new Date(Date.now() + clampChainDelaySeconds(task.payload.cadenceSeconds) * 1000)
        : task.runAt
          ? new Date(task.runAt)
          : null;

    if (!runAt || runAt.getTime() <= Date.now()) {
      throw new SchedulerInputError(
        "This task's run time has already passed. Create a new task instead of resuming.",
      );
    }

    // Pausing cancelled the original job, so resume sends a fresh one.
    const jobId = await boss.sendAfter(TASK_QUEUE_NAME, { taskId: id }, taskSendOptions(id), runAt);

    if (!jobId) {
      throw new Error("pg-boss did not return a job id while resuming the task.");
    }

    await getDb()
      .update(agentScheduledTasks)
      .set({ status: "active", jobId, updatedAt: sql`now()` })
      .where(eq(agentScheduledTasks.id, id));
  }

  return requireScheduledTask(id);
}

export async function listScheduledTasks() {
  const db = getDb();

  // Latest run per task, correlated to the outer row via the lateral join.
  const latestRun = db
    .select({
      status: agentScheduledTaskRuns.status,
      startedAt: agentScheduledTaskRuns.startedAt,
      completedAt: agentScheduledTaskRuns.completedAt,
      output: agentScheduledTaskRuns.output,
      error: agentScheduledTaskRuns.error,
    })
    .from(agentScheduledTaskRuns)
    .where(eq(agentScheduledTaskRuns.taskId, agentScheduledTasks.id))
    .orderBy(desc(agentScheduledTaskRuns.startedAt))
    .limit(1)
    .as("r");

  const rows = await db
    .select({
      ...getTableColumns(agentScheduledTasks),
      dedicatedSessionId: agentChatSessions.id,
      lastRunStatus: latestRun.status,
      lastRunStartedAt: latestRun.startedAt,
      lastRunCompletedAt: latestRun.completedAt,
      lastRunOutput: latestRun.output,
      lastRunError: latestRun.error,
    })
    .from(agentScheduledTasks)
    .leftJoin(
      agentChatSessions,
      and(
        eq(agentChatSessions.taskId, agentScheduledTasks.id),
        isNull(agentChatSessions.deletedAt),
      ),
    )
    .leftJoinLateral(latestRun, sql`true`)
    .orderBy(desc(agentScheduledTasks.createdAt))
    .limit(100);

  return rows.map(mapTaskRow);
}

export async function getScheduledTaskById(id: string) {
  const rows = await getDb()
    .select({
      ...getTableColumns(agentScheduledTasks),
      dedicatedSessionId: agentChatSessions.id,
    })
    .from(agentScheduledTasks)
    .leftJoin(
      agentChatSessions,
      and(
        eq(agentChatSessions.taskId, agentScheduledTasks.id),
        isNull(agentChatSessions.deletedAt),
      ),
    )
    .where(eq(agentScheduledTasks.id, id));

  return rows[0] ? mapTaskRow(rows[0]) : null;
}

export async function getScheduledTaskRuns(taskId: string) {
  await requireScheduledTask(taskId);

  const rows = await getDb()
    .select()
    .from(agentScheduledTaskRuns)
    .where(eq(agentScheduledTaskRuns.taskId, taskId))
    .orderBy(desc(agentScheduledTaskRuns.startedAt))
    .limit(50);

  return rows.map(
    (row): ScheduledTaskRun => ({
      id: row.id,
      taskId: row.taskId,
      status: row.status,
      output: row.output,
      error: row.error,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    }),
  );
}

// --- Worker-facing helpers -------------------------------------------------

export async function markRunStarted(
  taskId: string,
  pgBossJobId: string,
  db: AppDbClient = getDb(),
) {
  await db
    .insert(agentScheduledTaskRuns)
    .values({ taskId, pgBossJobId, status: "running" })
    .onConflictDoUpdate({
      target: agentScheduledTaskRuns.pgBossJobId,
      set: {
        status: "running",
        startedAt: sql`now()`,
        completedAt: null,
        output: null,
        error: null,
      },
    });
}

export async function markRunSkipped(
  taskId: string,
  pgBossJobId: string,
  reason: string,
  db: AppDbClient = getDb(),
) {
  await db
    .insert(agentScheduledTaskRuns)
    .values({ taskId, pgBossJobId, status: "skipped", error: reason, completedAt: sql`now()` })
    .onConflictDoUpdate({
      target: agentScheduledTaskRuns.pgBossJobId,
      set: { status: "skipped", error: reason, completedAt: sql`now()` },
    });
}

export async function markRunCompleted(
  pgBossJobId: string,
  output: unknown,
  db: AppDbClient = getDb(),
) {
  await db
    .update(agentScheduledTaskRuns)
    .set({
      status: "completed",
      // Mirror the original raw query: stringify then cast text -> jsonb, so an
      // object is encoded exactly once (drizzle's jsonb would re-stringify a
      // pre-stringified string) and a literal null is stored as jsonb 'null'.
      output: sql`${output === undefined ? null : JSON.stringify(output)}::jsonb`,
      completedAt: sql`now()`,
    })
    .where(eq(agentScheduledTaskRuns.pgBossJobId, pgBossJobId));
}

export async function markRunFailed(
  pgBossJobId: string,
  error: string,
  db: AppDbClient = getDb(),
) {
  await db
    .update(agentScheduledTaskRuns)
    .set({ status: "failed", error, completedAt: sql`now()` })
    .where(eq(agentScheduledTaskRuns.pgBossJobId, pgBossJobId));
}

export async function markTaskCompleted(id: string) {
  await getDb()
    .update(agentScheduledTasks)
    .set({ status: "completed", updatedAt: sql`now()` })
    .where(and(eq(agentScheduledTasks.id, id), eq(agentScheduledTasks.status, "active")));
}

/** Abnormal chain stop (e.g. consecutive failures). No pending job to detach. */
export async function markTaskCancelled(id: string) {
  await getDb()
    .update(agentScheduledTasks)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(and(eq(agentScheduledTasks.id, id), eq(agentScheduledTasks.status, "active")));
}

/** Advance an instruction payload's round counter ahead of the next fire. */
export async function setInstructionRound(id: string, round: number) {
  await getDb()
    .update(agentScheduledTasks)
    .set({
      payload: sql`jsonb_set(${agentScheduledTasks.payload}, '{round}', to_jsonb(${round}::int), true)`,
      updatedAt: sql`now()`,
    })
    .where(eq(agentScheduledTasks.id, id));
}

/** Keep job_id pointing at the latest chained job so pause can cancel it. */
export async function updateTaskJobId(id: string, jobId: string) {
  await getDb()
    .update(agentScheduledTasks)
    .set({ jobId, updatedAt: sql`now()` })
    .where(eq(agentScheduledTasks.id, id));
}

export async function getLatestCompletedRunOutput(taskId: string) {
  const rows = await getDb()
    .select({ output: agentScheduledTaskRuns.output })
    .from(agentScheduledTaskRuns)
    .where(
      and(
        eq(agentScheduledTaskRuns.taskId, taskId),
        eq(agentScheduledTaskRuns.status, "completed"),
      ),
    )
    .orderBy(desc(agentScheduledTaskRuns.startedAt))
    .limit(1);

  return rows[0]?.output ?? null;
}

/** Length of the trailing run of 'failed' statuses, capped at `limit`. */
export async function countConsecutiveFailedRuns(taskId: string, limit: number) {
  const rows = await getDb()
    .select({ status: agentScheduledTaskRuns.status })
    .from(agentScheduledTaskRuns)
    .where(eq(agentScheduledTaskRuns.taskId, taskId))
    .orderBy(desc(agentScheduledTaskRuns.startedAt))
    .limit(limit);

  let failures = 0;

  for (const row of rows) {
    if (row.status !== "failed") {
      break;
    }

    failures += 1;
  }

  return failures;
}

// --- Internals --------------------------------------------------------------

async function updateTaskStatus(id: string, status: ScheduledTaskStatus) {
  await getDb()
    .update(agentScheduledTasks)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(agentScheduledTasks.id, id));
}

async function requireScheduledTask(id: string) {
  const task = await getScheduledTaskById(id);

  if (!task) {
    throw new ScheduledTaskNotFoundError(id);
  }

  return task;
}

async function detachFromBoss(task: ScheduledTask) {
  const boss = await getBoss();

  if (task.scheduleType === "cron") {
    await boss.unschedule(TASK_QUEUE_NAME, task.id);
  } else if (task.jobId) {
    await boss.cancel(TASK_QUEUE_NAME, task.jobId);
  }
}

function parseRunAt(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    throw new SchedulerInputError("A runAt timestamp is required for one-off tasks.");
  }

  const runAt = new Date(trimmed);

  if (Number.isNaN(runAt.getTime())) {
    throw new SchedulerInputError(`'${trimmed}' is not a valid ISO 8601 timestamp.`);
  }

  if (runAt.getTime() <= Date.now()) {
    throw new SchedulerInputError("runAt must be in the future.");
  }

  return runAt;
}

function parseCron(cron: string, timezone: string) {
  try {
    // Same parser and options pg-boss validates with, so anything accepted
    // here is also accepted by boss.schedule and the catch-up reconciler.
    parseCronExpression(cron, timezone);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SchedulerInputError(`Invalid cron expression '${cron}': ${message}`);
  }
}

function parseTimezone(value: string | undefined) {
  const timezone = value?.trim() || getDefaultScheduleTimezone();

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new SchedulerInputError(`'${timezone}' is not a valid IANA timezone.`);
  }

  return timezone;
}

function mapTaskRow(row: TaskRow): ScheduledTask {
  // Home = the originating chat if there is one, else the task's dedicated
  // session (left-joined on read). Standalone tasks always have the latter from
  // createScheduledTask; only legacy rows predating sessions resolve to null.
  const homeSessionId = row.originSessionId ?? row.dedicatedSessionId ?? null;

  return {
    id: row.id,
    title: row.title,
    payload: row.payload,
    scheduleType: row.scheduleType,
    runAt: row.runAt?.toISOString() ?? null,
    cron: row.cron,
    timezone: row.timezone,
    status: row.status,
    jobId: row.jobId,
    originSessionId: row.originSessionId ?? null,
    homeSessionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRun: row.lastRunStatus
      ? {
          status: row.lastRunStatus,
          startedAt: row.lastRunStartedAt?.toISOString() ?? "",
          completedAt: row.lastRunCompletedAt?.toISOString() ?? null,
          output: row.lastRunOutput ?? null,
          error: row.lastRunError ?? null,
        }
      : null,
  };
}
