import { PgBoss } from "pg-boss";

import { getPgBossSchema, requireDatabaseUrl } from "@/lib/scheduler/env";

export const TASK_QUEUE_NAME = "agent-task-run";
export const TASK_DLQ_NAME = "agent-task-run-dlq";
export const TURN_REVIEW_QUEUE_NAME = "agent-turn-review";
export const TURN_REVIEW_DLQ_NAME = "agent-turn-review-dlq";
// The consolidation sweep runs on its OWN internal queue — it is not the
// user-facing agent-task-run queue and never appears as a user scheduled task.
export const CONSOLIDATION_QUEUE_NAME = "agent-consolidation";
export const CONSOLIDATION_DLQ_NAME = "agent-consolidation-dlq";

/**
 * Every job on the task queue must carry the task id as its singleton key.
 * The queue's 'stately' policy keeps at most one queued job per key, which
 * coalesces cron fires that stack up while no worker is consuming — and it
 * limits keyless jobs to one per queue, so a send without the key would make
 * unrelated tasks' jobs silently swallow each other.
 */
export function taskSendOptions(taskId: string) {
  return { singletonKey: taskId };
}

export function taskScheduleOptions(taskId: string, timezone: string) {
  return { key: taskId, tz: timezone, ...taskSendOptions(taskId) };
}

/** One pending review per session is enough; a later turn supersedes queued noise. */
export function turnReviewSendOptions(sessionId: string) {
  return { singletonKey: sessionId };
}

/**
 * Every consolidation job carries the agent id as its singleton key. The
 * 'stately' policy keeps at most one queued job per agent, which coalesces cron
 * fires that stack up while no worker is consuming — so a sweep never runs
 * twice concurrently for the same agent.
 */
export function consolidationSendOptions(agentId: string) {
  return { singletonKey: agentId };
}

type BossGlobal = {
  __schedulerBoss?: {
    boss: PgBoss;
    started: Promise<PgBoss>;
  };
};

const globalForBoss = globalThis as BossGlobal;

function createBoss() {
  const boss = new PgBoss({
    connectionString: requireDatabaseUrl(),
    schema: getPgBossSchema(),
  });

  boss.on("error", (error) => {
    console.error("pg-boss error", error);
  });
  boss.on("warning", (warning) => {
    console.warn("pg-boss warning", warning);
  });

  return boss;
}

async function startAndPrepare(boss: PgBoss) {
  await boss.start();
  await boss.createQueue(TASK_DLQ_NAME, {
    retentionSeconds: 14 * 24 * 60 * 60,
  });
  await boss.createQueue(TURN_REVIEW_DLQ_NAME, {
    retentionSeconds: 14 * 24 * 60 * 60,
  });
  // Consolidation DLQ — created before the queue so deadLetter resolves.
  await boss.createQueue(CONSOLIDATION_DLQ_NAME, {
    retentionSeconds: 14 * 24 * 60 * 60,
  });
  // Queues created before this option existed keep 'standard' (createQueue
  // is ON CONFLICT DO NOTHING); the worker's catch-up reconciler migrates
  // them once their schedules carry singleton keys.
  await boss.createQueue(TASK_QUEUE_NAME, {
    deadLetter: TASK_DLQ_NAME,
    expireInSeconds: 5 * 60,
    policy: "stately",
    retryBackoff: true,
    retryDelay: 5,
    retryLimit: 2,
  });
  await boss.createQueue(TURN_REVIEW_QUEUE_NAME, {
    deadLetter: TURN_REVIEW_DLQ_NAME,
    expireInSeconds: 5 * 60,
    policy: "stately",
    retryBackoff: true,
    retryDelay: 5,
    retryLimit: 2,
  });
  // The consolidation sweep queue. 'stately' + singletonKey(agentId) keeps at
  // most one queued sweep per agent. Not the user-facing task queue.
  await boss.createQueue(CONSOLIDATION_QUEUE_NAME, {
    deadLetter: CONSOLIDATION_DLQ_NAME,
    expireInSeconds: 10 * 60,
    policy: "stately",
    retryBackoff: true,
    retryDelay: 30,
    retryLimit: 1,
  });
  return boss;
}

/**
 * Get the process-wide pg-boss instance, starting it on first call. Safe to
 * call from request handlers and the worker alike; the schema and queues are
 * created on first start. The instance is cached on globalThis so Next.js dev
 * hot reloads do not leak connections.
 */
export function getBoss(): Promise<PgBoss> {
  if (!globalForBoss.__schedulerBoss) {
    const boss = createBoss();
    globalForBoss.__schedulerBoss = {
      boss,
      started: startAndPrepare(boss).catch(async (error) => {
        // boss.start() may have succeeded before a later step failed; stop
        // this instance so its pool and timers don't leak, and only clear
        // the cache slot if it still belongs to this instance.
        await boss.stop({ graceful: false }).catch(() => undefined);

        if (globalForBoss.__schedulerBoss?.boss === boss) {
          globalForBoss.__schedulerBoss = undefined;
        }

        throw error;
      }),
    };
  }

  return globalForBoss.__schedulerBoss.started;
}

export async function stopBoss(options?: { graceful?: boolean }) {
  const entry = globalForBoss.__schedulerBoss;

  if (!entry) {
    return;
  }

  globalForBoss.__schedulerBoss = undefined;
  await entry.started.catch(() => undefined);
  await entry.boss.stop({ graceful: options?.graceful ?? true });
}
