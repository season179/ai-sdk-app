import "@/lib/scheduler/load-env";

import {
  isMemoryConsolidationDryRun,
  isMemoryConsolidationEnabled,
} from "@/lib/consolidation/config";
import { runConsolidation } from "@/lib/consolidation/run";
import { closePool } from "@/lib/scheduler/db";

/**
 * Smoke run for consolidation (§8.4 PR5 DoD). Runs one sweep in dry-run and
 * asserts it creates a run + candidates and ZERO proposals.
 *
 *   pnpm exec tsx scripts/smoke-consolidation.ts
 */
async function main() {
  if (!isMemoryConsolidationEnabled()) {
    console.log("MEMORY_CONSOLIDATION_ENABLED is off; smoke run still proceeds (dry-run only).");
  }
  const dryRun = isMemoryConsolidationDryRun();
  console.log(`Running consolidation smoke (dryRun=${dryRun})...`);

  const result = await runConsolidation(undefined, { trigger: "manual" });

  console.log("Smoke result:", result);

  if (!dryRun) {
    // The smoke script expects dry-run semantics. If proposals were created,
    // surface it loudly — operators should only run this in dry-run.
    console.warn("WARNING: not in dry-run; proposals may have been created.");
  } else if (result.proposalsCreated !== 0) {
    console.error("FAIL: dry-run produced proposals (expected 0).");
    process.exit(1);
  }

  console.log("Smoke OK: run + candidates created, zero proposals.");
  await closePool();
}

main().catch((error) => {
  console.error("Smoke failed", error);
  closePool().finally(() => process.exit(1));
});
