import "@/lib/scheduler/load-env";

import { isProfileSynthesisEnabled } from "@/lib/profile/config";
import {
  enqueueProfileSweepAgents,
  type ProfileSynthesisJobData,
  registerProfileSynthesisWorker,
  storedTriggerForJob,
  syncProfileSynthesisSchedule,
} from "@/lib/profile/jobs";
import { synthesizeProfile } from "@/lib/profile/synthesis";
import { getBoss, stopBoss } from "@/lib/scheduler/boss";
import { closePool } from "@/lib/scheduler/db";

export async function processProfileSynthesisJob(
  data: ProfileSynthesisJobData,
  jobId: string,
): Promise<void> {
  if (data.kind === "sweep") {
    const count = await enqueueProfileSweepAgents();
    console.log(`Profile synthesis sweep enqueued ${count} agent job(s).`);
    return;
  }
  try {
    const result = await synthesizeProfile(data.agentId, {
      trigger: storedTriggerForJob(data.trigger),
      synthesisKey: `pg-boss:${jobId}`,
      maxAttempts: 1,
    });
    console.log(
      `Profile synthesis ${data.trigger} for agent ${data.agentId}: ${result.result}${result.profileVersionId ? ` ${result.profileVersionId}` : ""}.`,
    );
  } catch (error) {
    console.error(`Profile synthesis job ${jobId} failed`, error);
    // Receipt + CAS idempotency makes pg-boss retries safe.
    throw error;
  }
}

async function main() {
  const boss = await getBoss();
  await syncProfileSynthesisSchedule();
  if (!isProfileSynthesisEnabled()) {
    console.log("AGENT_PROFILE_SYNTHESIS_ENABLED is off; profile worker exiting.");
    await stopBoss({ graceful: true });
    await closePool();
    return;
  }
  await registerProfileSynthesisWorker(boss, processProfileSynthesisJob);
  console.log("Profile synthesis worker listening on 'agent-profile-synthesis'.");
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping profile synthesis worker...`);
  try {
    await stopBoss({ graceful: true });
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error("Profile synthesis worker shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
main().catch((error) => {
  console.error("Profile synthesis worker failed to start", error);
  process.exit(1);
});
