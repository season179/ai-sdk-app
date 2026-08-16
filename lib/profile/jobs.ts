import { isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { agentChatSessions, agentMemories, agentProfiles } from "@/db/schema";
import {
  getProfileSynthesisCron,
  getProfileSynthesisTimezone,
  isAutomaticProfileSynthesisEnabled,
  isProfileSynthesisEnabled,
} from "@/lib/profile/config";
import type { ProfileVersionTrigger } from "@/lib/profile/types";
import {
  getBoss,
  PROFILE_SYNTHESIS_QUEUE_NAME,
  profileSynthesisSendOptions,
} from "@/lib/scheduler/boss";
import { isUuid } from "@/lib/utils";

export { PROFILE_SYNTHESIS_QUEUE_NAME };

export type ProfileAgentJobData = {
  kind: "agent";
  agentId: string;
  trigger: "turn" | "scheduled" | "manual_ui" | "explicit_fallback";
};
export type ProfileSweepJobData = { kind: "sweep"; trigger: "scheduled" };
export type ProfileSynthesisJobData = ProfileAgentJobData | ProfileSweepJobData;

const CRON_NAME = "agent-profile-synthesis-schedule";

export function storedTriggerForJob(
  trigger: ProfileAgentJobData["trigger"],
): ProfileVersionTrigger {
  if (trigger === "manual_ui") return "manual_ui";
  if (trigger === "explicit_fallback") return "explicit";
  return "scheduled";
}

export async function enqueueProfileSynthesis(
  agentId: string,
  options: { trigger: ProfileAgentJobData["trigger"] },
): Promise<string | null> {
  if (!isProfileSynthesisEnabled()) return null;
  if (
    (options.trigger === "turn" || options.trigger === "scheduled") &&
    !isAutomaticProfileSynthesisEnabled()
  ) {
    return null;
  }
  const boss = await getBoss();
  return boss.send(
    PROFILE_SYNTHESIS_QUEUE_NAME,
    { kind: "agent", agentId, trigger: options.trigger } satisfies ProfileAgentJobData,
    {
      ...profileSynthesisSendOptions(agentId),
      ...(options.trigger === "explicit_fallback" ? { priority: 10 } : {}),
    },
  );
}

export async function syncProfileSynthesisSchedule(): Promise<void> {
  const boss = await getBoss();
  const cron = getProfileSynthesisCron();
  if (!isAutomaticProfileSynthesisEnabled() || !cron) {
    try {
      await boss.unschedule(PROFILE_SYNTHESIS_QUEUE_NAME, CRON_NAME);
    } catch {
      // Missing schedules are already in the desired state.
    }
    return;
  }
  await boss.schedule(
    PROFILE_SYNTHESIS_QUEUE_NAME,
    cron,
    { kind: "sweep", trigger: "scheduled" } satisfies ProfileSweepJobData,
    {
      key: CRON_NAME,
      tz: getProfileSynthesisTimezone(),
      ...profileSynthesisSendOptions("sweep"),
    },
  );
}

export async function enqueueProfileSweepAgents(): Promise<number> {
  if (!isAutomaticProfileSynthesisEnabled()) return 0;
  const db = getDb();
  const [profileRows, sessionRows, memoryRows] = await Promise.all([
    db.selectDistinct({ agentId: agentProfiles.agentId }).from(agentProfiles),
    db
      .selectDistinct({ agentId: agentChatSessions.agentId })
      .from(agentChatSessions)
      .where(isNull(agentChatSessions.deletedAt)),
    db.selectDistinct({ agentId: agentMemories.agentId }).from(agentMemories),
  ]);
  const agentIds = new Set(
    [...profileRows, ...sessionRows, ...memoryRows]
      .map((row) => row.agentId)
      .filter((agentId) => isUuid(agentId)),
  );
  let count = 0;
  for (const agentId of agentIds) {
    const jobId = await enqueueProfileSynthesis(agentId, { trigger: "scheduled" });
    if (jobId) count += 1;
  }
  return count;
}

export async function registerProfileSynthesisWorker(
  boss: Awaited<ReturnType<typeof getBoss>>,
  handler: (data: ProfileSynthesisJobData, jobId: string) => Promise<void>,
): Promise<void> {
  await boss.work<ProfileSynthesisJobData>(
    PROFILE_SYNTHESIS_QUEUE_NAME,
    { pollingIntervalSeconds: 10 },
    async (jobs) => {
      for (const job of jobs) {
        const data = parseProfileSynthesisJobData(job.data);
        if (!data) continue;
        await handler(data, job.id);
      }
    },
  );
}

export function parseProfileSynthesisJobData(value: unknown): ProfileSynthesisJobData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.kind === "sweep" && data.trigger === "scheduled") {
    return { kind: "sweep", trigger: "scheduled" };
  }
  if (
    data.kind === "agent" &&
    typeof data.agentId === "string" &&
    isUuid(data.agentId) &&
    (data.trigger === "turn" ||
      data.trigger === "scheduled" ||
      data.trigger === "manual_ui" ||
      data.trigger === "explicit_fallback")
  ) {
    return {
      kind: "agent",
      agentId: data.agentId,
      trigger: data.trigger,
    };
  }
  return null;
}
