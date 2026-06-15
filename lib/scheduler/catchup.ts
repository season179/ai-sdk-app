import { CronExpressionParser } from "cron-parser";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { getDb } from "@/db";
import { agentScheduledTaskRuns, agentScheduledTasks } from "@/db/schema";
import {
  getBoss,
  TASK_QUEUE_NAME,
  taskScheduleOptions,
  taskSendOptions,
} from "@/lib/scheduler/boss";
import { getPool } from "@/lib/scheduler/db";
import { getPgBossSchema } from "@/lib/scheduler/env";

/**
 * Worker-startup recovery entry point. Phases are isolated: a failure in
 * cron catch-up must not block chain-liveness recovery, and vice versa.
 */
export async function recoverMissedRuns() {
  let cronRuns = 0;
  let chainRuns = 0;

  try {
    cronRuns = await recoverMissedCronRuns();
  } catch (error) {
    console.error("Cron missed-run catch-up failed", error);
  }

  try {
    chainRuns = await recoverBrokenInstructionChains();
  } catch (error) {
    console.error("Instruction-chain liveness recovery failed", error);
  }

  return { cronRuns, chainRuns };
}

/**
 * Recover cron fires that were missed while no scheduler instance was
 * running, launchd-style: however long the outage, each task gets at most
 * one catch-up run. pg-boss itself only backfills fires missed within the
 * last ~60 seconds, so a longer full outage silently drops them.
 *
 * Order matters when upgrading a deployment from before coalescing existed:
 * schedules are re-asserted first so every fire carries its singleton key,
 * the queue policy is flipped to 'stately' only after that (keyless fires
 * under stately would collide queue-wide), and catch-up jobs are sent last
 * so the policy dedupes them against queued fires and against other
 * replicas reconciling concurrently.
 *
 * Failures are isolated per task — one bad row must not block other tasks'
 * recovery or stop the worker from consuming.
 */
export async function recoverMissedCronRuns() {
  const boss = await getBoss();
  const db = getDb();

  // baseline: updated_at moves on pause/resume, so fires due while a task
  // was paused (or before it existed) never count as missed. db_now anchors
  // the cron evaluation to the database clock — the same clock the fires
  // and run timestamps live on — so app-host clock skew cannot misjudge a
  // fire as missed.
  const latestRun = db
    .select({ startedAt: agentScheduledTaskRuns.startedAt })
    .from(agentScheduledTaskRuns)
    .where(eq(agentScheduledTaskRuns.taskId, agentScheduledTasks.id))
    .orderBy(desc(agentScheduledTaskRuns.startedAt))
    .limit(1)
    .as("r");

  const rows = await db
    .select({
      id: agentScheduledTasks.id,
      title: agentScheduledTasks.title,
      // schedule_type = 'cron' guarantees cron is non-null (table CHECK).
      cron: sql<string>`${agentScheduledTasks.cron}`,
      timezone: agentScheduledTasks.timezone,
      baseline: sql<Date>`greatest(${agentScheduledTasks.updatedAt}, ${latestRun.startedAt})`,
      dbNow: sql<Date>`now()`,
    })
    .from(agentScheduledTasks)
    .leftJoinLateral(latestRun, sql`true`)
    .where(
      and(eq(agentScheduledTasks.status, "active"), eq(agentScheduledTasks.scheduleType, "cron")),
    );

  const reasserted: typeof rows = [];

  for (const row of rows) {
    try {
      await boss.schedule(
        TASK_QUEUE_NAME,
        row.cron,
        { taskId: row.id },
        taskScheduleOptions(row.id, row.timezone),
      );
      reasserted.push(row);
    } catch (error) {
      console.warn(`Skipping catch-up for task ${row.id}: re-asserting its schedule failed`, error);
    }
  }

  await ensureStatelyPolicy(boss);

  let recovered = 0;

  for (const row of reasserted) {
    try {
      const lastDueFire = CronExpressionParser.parse(row.cron, {
        tz: row.timezone,
        currentDate: row.dbNow,
      })
        .prev()
        .toDate();

      if (lastDueFire <= row.baseline) {
        continue;
      }

      const jobId = await boss.send(TASK_QUEUE_NAME, { taskId: row.id }, taskSendOptions(row.id));

      if (jobId) {
        recovered += 1;
        console.log(
          `Catch-up run queued for task ${row.id} ('${row.title}'); ` +
            `fire due ${lastDueFire.toISOString()} was missed.`,
        );
      }
    } catch (error) {
      console.warn(`Catch-up failed for task ${row.id}`, error);
    }
  }

  return recovered;
}

/**
 * Re-assert instruction-chain liveness. Invariant: an active self-chaining
 * (once + instruction) task has exactly one pending job — the whole
 * recurrence lives in it, so a worker crash between completing a round and
 * sending its successor kills the chain. Queue one immediate job for any
 * active chain task with nothing pending; the stately singleton key dedupes
 * against races with a job that appears concurrently.
 */
export async function recoverBrokenInstructionChains() {
  const boss = await getBoss();

  const { rows } = await getPool().query<{ id: string; title: string }>(
    `select t.id, t.title
     from agent_scheduled_tasks t
     where t.status = 'active'
       and t.schedule_type = 'once'
       and t.payload->>'kind' = 'instruction'
       and not exists (
         select 1
         from ${getPgBossSchema()}.job j
         where j.name = $1
           and j.singleton_key = t.id::text
           and j.state in ('created', 'retry', 'active')
       )`,
    [TASK_QUEUE_NAME],
  );

  let recovered = 0;

  for (const row of rows) {
    try {
      const jobId = await boss.send(TASK_QUEUE_NAME, { taskId: row.id }, taskSendOptions(row.id));

      if (jobId) {
        recovered += 1;
        console.log(
          `Chain liveness restored for task ${row.id} ('${row.title}'): ` +
            "no pending job existed for this active instruction chain.",
        );
      }
    } catch (error) {
      console.warn(`Chain liveness recovery failed for task ${row.id}`, error);
    }
  }

  return recovered;
}

async function ensureStatelyPolicy(boss: PgBoss) {
  // createQueue is ON CONFLICT DO NOTHING and updateQueue cannot change a
  // policy, so a queue created before the stately policy keeps 'standard'
  // unless the row is flipped directly. Enforcement comes from the shared
  // job-table indexes, which cover every policy.
  await getPool().query(
    `update ${getPgBossSchema()}.queue
     set policy = 'stately', updated_on = now()
     where name = $1 and policy is distinct from 'stately'`,
    [TASK_QUEUE_NAME],
  );

  // Coalescing silently degrades to job stacking if the policy is not in
  // effect (e.g. a future pg-boss changes its queue storage), so fail loud.
  const queue = await boss.getQueue(TASK_QUEUE_NAME);

  if (queue?.policy !== "stately") {
    console.error(
      `Queue '${TASK_QUEUE_NAME}' policy is '${queue?.policy}' instead of 'stately'; ` +
        "missed cron fires will stack up instead of coalescing.",
    );
  }
}
