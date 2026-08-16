import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProfileFactV1 } from "@/lib/profile/types";
import { closePool, getPool } from "@/lib/scheduler/db";

const DATABASE_AVAILABLE =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const describeIntegration = DATABASE_AVAILABLE ? describe : describe.skip;

const validFact: ProfileFactV1 = {
  factKey: "favorite-editor",
  sentence: "The user prefers keyboard-first editing.",
  category: "preferences_constraints",
  authority: "synthesized",
  protected: false,
  order: 0,
};

async function insertVersion(
  client: PoolClient,
  input: {
    id?: string;
    agentId: string;
    body?: string;
    facts?: unknown;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await client.query(
    `insert into agent_profile_versions (
       id, agent_id, version_no, body, facts, trigger, authority, token_count,
       recorded_during, prompt_hash, policy_version
     ) values ($1, $2, 1, $3, $4::jsonb, 'scheduled', 'synthesized', 12,
       tstzrange(now(), null, '[)'), 'test-prompt', 'profile-v1')`,
    [
      id,
      input.agentId,
      input.body ?? validFact.sentence,
      JSON.stringify(input.facts ?? [validFact]),
    ],
  );
  return id;
}

async function insertTraceEvent(client: PoolClient, agentId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into agent_trace_events (
       id, agent_id, trace_id, sequence_no, event_type, actor, trust_class,
       payload, content_hash, idempotency_key, retention_class, policy_version, occurred_at
     ) values ($1, $2, $3, 0, 'user_message', 'user', 'user_assertion',
       '{}'::jsonb, $4, $5, 'audit', 'profile-schema-test', now())`,
    [id, agentId, `profile-schema-test:${id}`, `hash:${id}`, `profile-schema-test:${id}`],
  );
  return id;
}

async function withRollback(run: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await run(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

describeIntegration("running profile foundation schema (integration)", () => {
  beforeAll(() => getPool());
  afterAll(async () => closePool());

  it("installs the tables, checks, indexes, foreign keys, generated column, and activation trigger", async () => {
    const pool = getPool();
    const tables = await pool.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any(array[
          'agent_profiles',
          'agent_profile_versions',
          'agent_profile_version_sources',
          'agent_profile_fact_tombstones',
          'agent_profile_synthesis_receipts'
        ])
      order by table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "agent_profile_fact_tombstones",
      "agent_profile_synthesis_receipts",
      "agent_profile_version_sources",
      "agent_profile_versions",
      "agent_profiles",
    ]);

    const columns = await pool.query<{
      column_name: string;
      is_generated: string;
      is_nullable: string;
    }>(`
      select column_name, is_generated, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name) in (
          ('agent_profile_versions', 'char_count'),
          ('agent_chat_messages', 'profile_version_id')
        )
      order by column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: "char_count", is_generated: "ALWAYS", is_nullable: "YES" },
      { column_name: "profile_version_id", is_generated: "NEVER", is_nullable: "YES" },
    ]);

    const checks = await pool.query<{ conname: string }>(`
      select conname
      from pg_constraint
      where contype = 'c'
        and conname = any(array[
          'agent_profiles_generations_check',
          'agent_profiles_error_check',
          'agent_profile_versions_body_check',
          'agent_profile_versions_facts_check',
          'agent_profile_versions_facts_v1_check',
          'agent_profile_versions_trigger_check',
          'agent_profile_versions_authority_check',
          'agent_profile_versions_token_count_check',
          'agent_profile_version_sources_shape_check',
          'agent_profile_version_sources_fact_key_check',
          'agent_profile_version_sources_role_check',
          'agent_profile_fact_tombstones_retired_shape_check',
          'agent_profile_fact_tombstones_fact_key_check',
          'agent_profile_fact_tombstones_reason_check',
          'agent_profile_synthesis_receipts_result_check',
          'agent_profile_synthesis_receipts_version_shape_check'
        ])
    `);
    expect(checks.rowCount).toBe(16);

    const indexes = await pool.query<{ indexname: string }>(`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname = any(array[
          'agent_profile_versions_supersedes_uniq',
          'agent_profile_versions_recorded_during_idx',
          'agent_profile_versions_agent_version_idx',
          'agent_profile_version_sources_trace_uniq',
          'agent_profile_version_sources_memory_uniq',
          'agent_profile_version_sources_trace_event_idx',
          'agent_profile_version_sources_memory_version_idx',
          'agent_profile_version_sources_fact_idx',
          'agent_profile_fact_tombstones_active_idx',
          'agent_chat_messages_profile_version_idx',
          'agent_chat_messages_time_search_idx'
        ])
    `);
    expect(indexes.rowCount).toBe(11);

    const foreignKeys = await pool.query<{ source_table: string; target_table: string }>(`
      select conrelid::regclass::text as source_table,
             confrelid::regclass::text as target_table
      from pg_constraint
      where contype = 'f'
        and (
          conrelid::regclass::text like 'agent_profile%'
          or (
            conrelid::regclass::text = 'agent_chat_messages'
            and confrelid::regclass::text = 'agent_profile_versions'
          )
        )
      order by source_table, target_table
    `);
    expect(foreignKeys.rows).toEqual([
      { source_table: "agent_chat_messages", target_table: "agent_profile_versions" },
      { source_table: "agent_profile_fact_tombstones", target_table: "agent_trace_events" },
      { source_table: "agent_profile_fact_tombstones", target_table: "agent_trace_events" },
      {
        source_table: "agent_profile_synthesis_receipts",
        target_table: "agent_profile_versions",
      },
      { source_table: "agent_profile_version_sources", target_table: "agent_memory_versions" },
      { source_table: "agent_profile_version_sources", target_table: "agent_profile_versions" },
      { source_table: "agent_profile_version_sources", target_table: "agent_trace_events" },
      { source_table: "agent_profile_versions", target_table: "agent_profile_versions" },
      { source_table: "agent_profiles", target_table: "agent_profile_versions" },
    ]);

    const trigger = await pool.query<{ trigger_count: number }>(`
      select count(*)::int as trigger_count
      from pg_trigger
      where tgname = 'agent_profiles_current_version_provenance_check'
        and tgconstraint <> 0
    `);
    expect(trigger.rows[0]?.trigger_count).toBe(1);
  });

  it("supports a valid cyclic root/version activation and nullable message binding", async () => {
    await withRollback(async (client) => {
      const agentId = randomUUID();
      const sessionId = randomUUID();
      const versionId = randomUUID();
      const traceEventId = await insertTraceEvent(client, agentId);

      await client.query("insert into agent_profiles (agent_id) values ($1)", [agentId]);
      await insertVersion(client, { id: versionId, agentId });
      await client.query(
        `insert into agent_profile_version_sources (
           profile_version_id, fact_key, trace_event_id, source_role
         ) values ($1, $2, $3, 'primary')`,
        [versionId, validFact.factKey, traceEventId],
      );
      await client.query("update agent_profiles set current_version_id = $1 where agent_id = $2", [
        versionId,
        agentId,
      ]);
      await client.query("set constraints all immediate");

      const version = await client.query<{ char_count: number }>(
        "select char_count from agent_profile_versions where id = $1",
        [versionId],
      );
      expect(version.rows[0]?.char_count).toBe(validFact.sentence.length);

      await client.query("insert into agent_chat_sessions (id, agent_id) values ($1, $2)", [
        sessionId,
        agentId,
      ]);
      await client.query(
        `insert into agent_chat_messages (id, session_id, role, parts, ordinal, profile_version_id)
         values ('message-1', $1, 'user', '[]'::jsonb, 0, null)`,
        [sessionId],
      );
      const message = await client.query<{ profile_version_id: string | null }>(
        `select profile_version_id from agent_chat_messages
         where session_id = $1 and id = 'message-1'`,
        [sessionId],
      );
      expect(message.rows[0]?.profile_version_id).toBeNull();
    });
  });

  it("allows an auditable empty head without source rows", async () => {
    await withRollback(async (client) => {
      const agentId = randomUUID();
      const versionId = randomUUID();

      await client.query("insert into agent_profiles (agent_id) values ($1)", [agentId]);
      await insertVersion(client, { id: versionId, agentId, body: "", facts: [] });
      await client.query("update agent_profiles set current_version_id = $1 where agent_id = $2", [
        versionId,
        agentId,
      ]);
      await client.query("set constraints all immediate");

      const head = await client.query<{ current_version_id: string }>(
        "select current_version_id from agent_profiles where agent_id = $1",
        [agentId],
      );
      expect(head.rows[0]?.current_version_id).toBe(versionId);
    });
  });

  it("rejects malformed fact JSON and rolls the transaction back cleanly", async () => {
    const client = await getPool().connect();
    const agentId = randomUUID();
    try {
      await client.query("begin");
      await client.query("insert into agent_profiles (agent_id) values ($1)", [agentId]);
      await expect(
        insertVersion(client, {
          agentId,
          facts: [{ factKey: "missing-required-fields" }],
        }),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback");

      const root = await client.query("select 1 from agent_profiles where agent_id = $1", [
        agentId,
      ]);
      expect(root.rowCount).toBe(0);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("rejects a body over the absolute 5,000-character ceiling", async () => {
    await withRollback(async (client) => {
      await expect(
        insertVersion(client, {
          agentId: randomUUID(),
          body: "x".repeat(5001),
          facts: [],
        }),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("rejects a source row that does not select exactly one source lane", async () => {
    await withRollback(async (client) => {
      const versionId = await insertVersion(client, { agentId: randomUUID() });
      await expect(
        client.query(
          `insert into agent_profile_version_sources (
             profile_version_id, fact_key, trace_event_id, memory_version_id, source_role
           ) values ($1, $2, null, null, 'primary')`,
          [versionId, validFact.factKey],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("enforces generation, receipt, and tombstone state shapes", async () => {
    await withRollback(async (client) => {
      await expect(
        client.query(
          `insert into agent_profiles (agent_id, dirty_generation, synthesized_generation)
           values ($1, 0, 1)`,
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    await withRollback(async (client) => {
      await expect(
        client.query(
          `insert into agent_profile_synthesis_receipts (
             agent_id, synthesis_key, synthesizer_id, profile_version_id,
             input_lower_bounds, input_upper_bounds, result
           ) values ($1, 'test', 'test-v1', null, '{}'::jsonb, '{}'::jsonb, 'created')`,
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    await withRollback(async (client) => {
      const agentId = randomUUID();
      const traceEventId = await insertTraceEvent(client, agentId);
      await expect(
        client.query(
          `insert into agent_profile_fact_tombstones (
             agent_id, fact_key, deleted_by, explicit_trace_event_id, retired_at
           ) values ($1, 'old-fact', 'user', $2, now())`,
          [agentId, traceEventId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("rejects source-less activation at the deferred commit boundary", async () => {
    const client = await getPool().connect();
    const agentId = randomUUID();
    const versionId = randomUUID();
    try {
      await client.query("begin");
      await client.query("insert into agent_profiles (agent_id) values ($1)", [agentId]);
      await insertVersion(client, { id: versionId, agentId });
      await client.query("update agent_profiles set current_version_id = $1 where agent_id = $2", [
        versionId,
        agentId,
      ]);
      await expect(client.query("commit")).rejects.toMatchObject({ code: "23514" });

      const rows = await client.query(
        `select 1 from agent_profiles where agent_id = $1
         union all
         select 1 from agent_profile_versions where id = $2`,
        [agentId, versionId],
      );
      expect(rows.rowCount).toBe(0);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});
