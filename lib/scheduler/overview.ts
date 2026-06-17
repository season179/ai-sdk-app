import { TASK_QUEUE_NAME } from "@/lib/scheduler/boss";
import { nextCronFire } from "@/lib/scheduler/cron";
import { getPool } from "@/lib/scheduler/db";
import { getPgBossSchema } from "@/lib/scheduler/env";
import type { ScheduledTaskPayload } from "@/lib/scheduler/execute";
import type { ScheduledTaskRunStatus } from "@/lib/scheduler/tasks";

export type ScheduledJobRun = {
  id: string;
  taskId: string;
  taskTitle: string;
  scheduleType: "once" | "cron";
  payloadKind: ScheduledTaskPayload["kind"];
  status: ScheduledTaskRunStatus;
  output: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  /**
   * The session a task's rounds are appended into: its originating chat
   * (origin_session_id) or, for a standalone task, its dedicated session.
   * Null for legacy tasks predating session provenance. Drives "View
   * transcript".
   */
  homeSessionId: string | null;
};

export type UpcomingScheduledJob = {
  taskId: string;
  taskTitle: string;
  scheduleType: "once" | "cron";
  payload: ScheduledTaskPayload;
  cron: string | null;
  timezone: string;
  /**
   * ISO timestamp of the next fire. Null for an active task with nothing
   * queued and no cron to project from — i.e. an instruction chain waiting
   * on worker-startup liveness recovery.
   */
  nextRunAt: string | null;
  /** True when the fire is a pending pg-boss job rather than a cron projection. */
  queued: boolean;
  /**
   * The session this task's rounds are appended into (see ScheduledJobRun).
   * Null for legacy tasks predating session provenance.
   */
  homeSessionId: string | null;
};

export type ScheduledJobsOverview = {
  running: ScheduledJobRun[];
  upcoming: UpcomingScheduledJob[];
  past: ScheduledJobRun[];
};

export async function getScheduledJobsOverview(): Promise<ScheduledJobsOverview> {
  const [running, past, upcoming] = await Promise.all([
    listRuns("r.status = 'running'", 50),
    listRuns("r.status <> 'running'", 100),
    listUpcomingJobs(),
  ]);

  return { running, upcoming, past };
}

type RunRow = {
  id: string;
  task_id: string;
  task_title: string;
  schedule_type: "once" | "cron";
  payload_kind: ScheduledTaskPayload["kind"];
  status: ScheduledTaskRunStatus;
  output: unknown;
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
  home_session_id: string | null;
};

async function listRuns(condition: string, limit: number) {
  // Resolve the home session inline: the originating chat (origin_session_id)
  // or the task's dedicated session (the live one joined on task_id). The
  // partial-unique task_id index makes that join at most one row.
  const { rows } = await getPool().query<RunRow>(
    `select r.id, r.task_id, r.status, r.output, r.error, r.started_at, r.completed_at,
            t.title as task_title, t.schedule_type, t.payload->>'kind' as payload_kind,
            coalesce(t.origin_session_id, s.id) as home_session_id
     from agent_scheduled_task_runs r
     join agent_scheduled_tasks t on t.id = r.task_id
     left join agent_chat_sessions s on s.task_id = t.id and s.deleted_at is null
     where ${condition}
     order by r.started_at desc
     limit $1`,
    [limit],
  );

  return rows.map(
    (row): ScheduledJobRun => ({
      id: row.id,
      taskId: row.task_id,
      taskTitle: row.task_title,
      scheduleType: row.schedule_type,
      payloadKind: row.payload_kind,
      status: row.status,
      output: row.output,
      error: row.error,
      startedAt: row.started_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      homeSessionId: row.home_session_id,
    }),
  );
}

type UpcomingRow = {
  id: string;
  title: string;
  schedule_type: "once" | "cron";
  payload: ScheduledTaskPayload;
  run_at: Date | null;
  cron: string | null;
  timezone: string;
  queued_start_after: Date | null;
  home_session_id: string | null;
  db_now: Date;
};

async function listUpcomingJobs() {
  // A pending job is the ground truth for the next fire: it covers queued
  // one-offs, mid-flight instruction chains (whose run_at is the long-past
  // first fire), and cron fires already coalesced into the queue. The cron
  // expression is only projected when nothing is queued yet.
  const { rows } = await getPool().query<UpcomingRow>(
    `select t.id, t.title, t.schedule_type, t.payload, t.run_at, t.cron, t.timezone,
            j.start_after as queued_start_after,
            coalesce(t.origin_session_id, s.id) as home_session_id,
            now() as db_now
     from agent_scheduled_tasks t
     left join agent_chat_sessions s on s.task_id = t.id and s.deleted_at is null
     left join lateral (
       select start_after
       from ${getPgBossSchema()}.job
       where name = $1
         and singleton_key = t.id::text
         and state in ('created', 'retry')
       order by start_after
       limit 1
     ) j on true
     where t.status = 'active'`,
    [TASK_QUEUE_NAME],
  );

  const upcoming = rows.map((row): UpcomingScheduledJob => {
    const { nextRunAt, queued } = resolveNextRun(row);

    return {
      taskId: row.id,
      taskTitle: row.title,
      scheduleType: row.schedule_type,
      payload: row.payload,
      cron: row.cron,
      timezone: row.timezone,
      nextRunAt,
      queued,
      homeSessionId: row.home_session_id,
    };
  });

  return upcoming.sort((a, b) => {
    if (a.nextRunAt && b.nextRunAt) {
      return a.nextRunAt.localeCompare(b.nextRunAt);
    }

    return a.nextRunAt ? -1 : b.nextRunAt ? 1 : 0;
  });
}

function resolveNextRun(row: UpcomingRow): Pick<UpcomingScheduledJob, "nextRunAt" | "queued"> {
  if (row.queued_start_after) {
    return { nextRunAt: row.queued_start_after.toISOString(), queued: true };
  }

  if (row.schedule_type === "cron" && row.cron) {
    try {
      const next = nextCronFire(row.cron, row.timezone, row.db_now);

      return { nextRunAt: next.toISOString(), queued: false };
    } catch {
      return { nextRunAt: null, queued: false };
    }
  }

  if (row.run_at && row.run_at.getTime() > row.db_now.getTime()) {
    return { nextRunAt: row.run_at.toISOString(), queued: false };
  }

  return { nextRunAt: null, queued: false };
}
