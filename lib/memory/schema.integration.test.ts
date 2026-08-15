import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { closePool, getPool } from "@/lib/scheduler/db";

const DATABASE_AVAILABLE =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const describeIntegration = DATABASE_AVAILABLE ? describe : describe.skip;

describeIntegration("agent memory write-plane schema (integration)", () => {
  beforeAll(() => getPool());
  afterAll(async () => closePool());

  it("installs pg_trgm and all managed write-plane tables", async () => {
    const result = await getDb().execute<{
      extension_installed: boolean;
      table_count: number;
    }>(`
      select
        exists(select 1 from pg_extension where extname = 'pg_trgm') as extension_installed,
        count(*)::int as table_count
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any(array[
          'agent_trace_artifacts',
          'agent_trace_events',
          'agent_memory_candidates',
          'agent_memory_candidate_trace_events',
          'agent_decisions',
          'agent_decision_trace_events',
          'agent_outcomes',
          'agent_outcome_trace_events',
          'agent_memory_versions',
          'agent_memory_version_trace_events'
        ])
    `);

    expect(result.rows[0]).toEqual({ extension_installed: true, table_count: 10 });
  });

  it("links every imported legacy-memory event to version provenance", async () => {
    const result = await getDb().execute<{ missing_count: number }>(`
      select count(*)::int as missing_count
      from agent_trace_events e
      left join agent_memory_version_trace_events p on p.event_id = e.id
      left join agent_memory_versions v on v.id = p.memory_version_id
      left join agent_memories m on m.id = v.memory_id and m.current_version_id = v.id
      where e.idempotency_key like 'legacy-memory:%'
        and (p.event_id is null or v.id is null or m.id is null)
    `);

    expect(result.rows[0]?.missing_count).toBe(0);
  });

  it("links every imported legacy-observation event to its observation", async () => {
    const result = await getDb().execute<{ missing_count: number }>(`
      select count(*)::int as missing_count
      from agent_trace_events e
      left join agent_grounded_observations o on o.trace_event_id = e.id
      where e.idempotency_key like 'legacy-observation:%'
        and o.id is null
    `);

    expect(result.rows[0]?.missing_count).toBe(0);
  });
});
