import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, getPool } from "@/lib/scheduler/db";

const DATABASE_AVAILABLE =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const describeIntegration = DATABASE_AVAILABLE ? describe : describe.skip;

/** Historical profile storage stays installed even though its runtime is retired. */
describeIntegration("historical profile schema (integration)", () => {
  beforeAll(() => getPool());
  afterAll(async () => closePool());

  it("retains profile tables and the nullable chat-message binding", async () => {
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

    const binding = await pool.query<{ is_nullable: string; target_table: string }>(`
      select columns.is_nullable, target.relname as target_table
      from information_schema.columns as columns
      join pg_constraint as con
        on con.conrelid = 'agent_chat_messages'::regclass
       and con.contype = 'f'
      join pg_class as target on target.oid = con.confrelid
      where columns.table_schema = 'public'
        and columns.table_name = 'agent_chat_messages'
        and columns.column_name = 'profile_version_id'
        and con.conkey = array[
          (
            select attnum
            from pg_attribute
            where attrelid = 'agent_chat_messages'::regclass
              and attname = 'profile_version_id'
          )::smallint
        ]
    `);

    expect(binding.rows).toEqual([{ is_nullable: "YES", target_table: "agent_profile_versions" }]);
  });
});
