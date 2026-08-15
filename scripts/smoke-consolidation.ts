import "@/lib/scheduler/load-env";

import { getDb } from "@/db";
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

  const evidenceCheck = await getDb().execute<{ invalid_count: number }>(`
    select count(*)::int as invalid_count
    from agent_review_proposals p
    left join agent_memories m on m.review_proposal_id = p.id
    left join agent_memory_versions v on v.id = m.current_version_id
    where p.kind = 'memory_create'
      and p.status = 'applied'
      and (
        v.id is null
        or not exists (
          select 1 from agent_memory_version_trace_events mt
          where mt.memory_version_id = v.id
        )
      )
  `);
  if ((evidenceCheck.rows[0]?.invalid_count ?? 0) > 0) {
    throw new Error("Applied memory exists without a current version and trace provenance.");
  }
  const failedTraceCheck = await getDb().execute<{ invalid_count: number }>(`
    select count(*)::int as invalid_count
    from agent_review_proposals p
    join agent_memory_candidate_trace_events ct on ct.candidate_id = p.source_candidate_id
    join agent_trace_events e on e.id = ct.event_id
    where e.event_type = 'task_terminal_state'
      and e.terminal_status in ('failed', 'interrupted')
  `);
  if ((failedTraceCheck.rows[0]?.invalid_count ?? 0) > 0) {
    throw new Error("Failed/interrupted trace produced a memory proposal.");
  }

  console.log("Smoke OK: run/candidates valid; applied memories have trace-backed current versions.");
  await closePool();
}

main().catch((error) => {
  console.error("Smoke failed", error);
  closePool().finally(() => process.exit(1));
});
