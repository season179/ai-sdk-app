import {
  getMemoryConsolidationCron,
  isMemoryConsolidationEnabled,
} from "@/lib/consolidation/config";
import { CONSOLIDATION_QUEUE_NAME, consolidationSendOptions, getBoss } from "@/lib/scheduler/boss";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

export { CONSOLIDATION_QUEUE_NAME };

export type ConsolidationJobData = {
  agentId: string;
  trigger: "scheduled" | "manual";
};

/**
 * Enqueue a consolidation sweep for an agent. The singletonKey(agentId) keeps
 * at most one queued sweep per agent (stately policy), so a manual "Run now"
 * coalesces with a pending cron fire instead of stacking.
 */
export async function enqueueConsolidation(
  agentId: string = DEFAULT_AGENT_ID,
  opts: { trigger?: "scheduled" | "manual" } = {},
): Promise<string | null> {
  const trigger = opts.trigger ?? "manual";
  const boss = await getBoss();
  const jobId = await boss.send(
    CONSOLIDATION_QUEUE_NAME,
    { agentId, trigger } satisfies ConsolidationJobData,
    consolidationSendOptions(agentId),
  );
  return jobId;
}

/**
 * Register (or unregister) the pg-boss cron schedule for consolidation, based
 * on the master switch and MEMORY_CONSOLIDATION_CRON. Called at worker startup.
 * When disabled or no cron is set, any existing schedule is unscheduled so the
 * sweep truly stops (§8.2 kill switch).
 */
const CRON_NAME = "agent-consolidation-schedule";

export async function syncConsolidationSchedule(): Promise<void> {
  const boss = await getBoss();
  const enabled = isMemoryConsolidationEnabled();
  const cron = getMemoryConsolidationCron();

  if (!enabled || !cron) {
    try {
      await boss.unschedule(CONSOLIDATION_QUEUE_NAME, CRON_NAME);
    } catch {
      // unschedule throws if the schedule doesn't exist; treat as a no-op.
    }
    return;
  }

  await boss.schedule(
    CONSOLIDATION_QUEUE_NAME,
    cron,
    { agentId: DEFAULT_AGENT_ID, trigger: "scheduled" } satisfies ConsolidationJobData,
    { key: CRON_NAME, ...consolidationSendOptions(DEFAULT_AGENT_ID) },
  );
}

/** Register the consolidation worker. Mirrors the turn-review worker shape. */
export async function registerConsolidationWorker(
  boss: Awaited<ReturnType<typeof getBoss>>,
  handler: (data: ConsolidationJobData) => Promise<void>,
): Promise<void> {
  await boss.work<ConsolidationJobData>(
    CONSOLIDATION_QUEUE_NAME,
    { pollingIntervalSeconds: 10 },
    async (jobs) => {
      for (const job of jobs) {
        const data = parseJobData(job.data);
        if (!data) {
          continue;
        }
        await handler(data);
      }
    },
  );
}

function parseJobData(value: unknown): ConsolidationJobData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const data = value as Partial<ConsolidationJobData>;
  if (typeof data.agentId !== "string" || typeof data.trigger !== "string") {
    return null;
  }
  if (data.trigger !== "scheduled" && data.trigger !== "manual") {
    return null;
  }
  return { agentId: data.agentId, trigger: data.trigger };
}
