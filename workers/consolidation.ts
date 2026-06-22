import "@/lib/scheduler/load-env";

import {
  isMemoryConsolidationEnabled,
  isMemoryConsolidationVerbose,
} from "@/lib/consolidation/config";
import {
  type ConsolidationJobData,
  registerConsolidationWorker,
  syncConsolidationSchedule,
} from "@/lib/consolidation/jobs";
import { runConsolidation } from "@/lib/consolidation/run";
import { getBoss, stopBoss } from "@/lib/scheduler/boss";
import { closePool } from "@/lib/scheduler/db";

const verbose = isMemoryConsolidationVerbose();

async function processJob(data: ConsolidationJobData) {
  try {
    const result = await runConsolidation(data.agentId, { trigger: data.trigger });
    if (verbose) {
      console.log(
        `Consolidation ${data.trigger} run for agent ${data.agentId}: ${result.observationsScanned} obs, ${result.candidatesEvaluated} candidates, ${result.proposalsCreated} proposals.`,
      );
    }
  } catch (error) {
    // Do not rethrow: a pg-boss retry would re-run the same sweep and could
    // double-propose. The run row is marked 'failed' with the error message.
    console.error(`Consolidation ${data.trigger} run failed for agent ${data.agentId}`, error);
  }
}

async function main() {
  if (!isMemoryConsolidationEnabled()) {
    // Ship dark (§8.1): the worker is harmless when the flag is off, but there
    // is no work to do. Keep the process alive only when enabled.
    console.log("MEMORY_CONSOLIDATION_ENABLED is off; consolidation worker exiting.");
    return;
  }

  const boss = await getBoss();
  await syncConsolidationSchedule();
  await registerConsolidationWorker(boss, processJob);

  console.log("Consolidation worker listening on 'agent-consolidation'.");
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}; stopping consolidation worker...`);

  try {
    await stopBoss({ graceful: true });
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error("Consolidation worker shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
  console.error("Consolidation worker failed to start", error);
  process.exit(1);
});
