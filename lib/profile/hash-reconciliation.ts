import { and, eq, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import { agentProfileFactTombstones, agentProfiles } from "@/db/schema";
import { profileClaimHash } from "@/lib/profile/reconcile";
import { ensureProfileRoot } from "@/lib/profile/repository";

export type TombstoneHashReconciliation = {
  scanned: number;
  legacyMatched: number;
  updated: number;
};

type LegacyTombstoneRow = {
  agent_id: string;
  fact_key: string;
  claim_hash: string;
  sentence: string;
  legacy_hash: string;
};

/**
 * Rewrites only hashes that still equal migration 0011's SQL digest. The new
 * value uses the runtime NFKC normalizer, so runtime-created tombstones are
 * never reinterpreted. Called by the scheduled sweep and safe to rerun.
 */
export async function reconcileLegacyTombstoneClaimHashes(
  agentId?: string,
): Promise<TombstoneHashReconciliation> {
  const rows = await readLegacyTombstones(getDb(), agentId);
  let legacyMatched = 0;
  let updated = 0;
  for (const candidate of rows) {
    if (candidate.claim_hash !== candidate.legacy_hash) continue;
    legacyMatched += 1;
    const runtimeHash = profileClaimHash(candidate.sentence);
    if (runtimeHash === candidate.claim_hash) continue;
    const changed = await getDb().transaction(async (tx) => {
      // Runtime tombstone writers already take this root first.
      await ensureProfileRoot(candidate.agent_id, tx);
      await tx
        .select({ agentId: agentProfiles.agentId })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, candidate.agent_id))
        .for("update");
      const [current] = await readLegacyTombstones(tx, candidate.agent_id, candidate.fact_key);
      if (!current || current.claim_hash !== current.legacy_hash) return false;
      const exactRuntimeHash = profileClaimHash(current.sentence);
      if (exactRuntimeHash === current.claim_hash) return false;
      const changedRows = await tx
        .update(agentProfileFactTombstones)
        .set({ claimHash: exactRuntimeHash })
        .where(
          and(
            eq(agentProfileFactTombstones.agentId, current.agent_id),
            eq(agentProfileFactTombstones.factKey, current.fact_key),
            eq(agentProfileFactTombstones.claimHash, current.claim_hash),
          ),
        )
        .returning({ factKey: agentProfileFactTombstones.factKey });
      return changedRows.length === 1;
    });
    if (changed) updated += 1;
  }
  return { scanned: rows.length, legacyMatched, updated };
}

async function readLegacyTombstones(
  db: AppDbClient,
  agentId?: string,
  factKey?: string,
): Promise<LegacyTombstoneRow[]> {
  const filters = [
    ...(agentId ? [sql`t.agent_id = ${agentId}`] : []),
    ...(factKey ? [sql`t.fact_key = ${factKey}`] : []),
  ];
  const where = filters.length ? sql`where ${sql.join(filters, sql` and `)}` : sql``;
  const result = await db.execute<LegacyTombstoneRow>(sql`
    select
      t.agent_id,
      t.fact_key,
      t.claim_hash,
      resolved.sentence,
      resolved.legacy_hash
    from agent_profile_fact_tombstones t
    cross join lateral (
      select candidate.sentence, candidate.legacy_hash
      from (
        select
          fact->>'sentence' as sentence,
          v.version_no,
          encode(digest(lower(regexp_replace(regexp_replace(
            fact->>'sentence', '[.!?。！？]+$', ''
          ), '\\s+', ' ', 'g')), 'sha256'), 'hex') as legacy_hash
        from agent_profile_versions v,
          lateral jsonb_array_elements(v.facts) as fact
        where v.agent_id = t.agent_id
          and fact->>'factKey' = t.fact_key
        union all
        select
          t.fact_key,
          -1,
          encode(digest(lower(regexp_replace(regexp_replace(
            t.fact_key, '[.!?。！？]+$', ''
          ), '\\s+', ' ', 'g')), 'sha256'), 'hex')
      ) candidate
      order by (candidate.legacy_hash = t.claim_hash) desc, candidate.version_no desc
      limit 1
    ) resolved
    ${where}
    order by t.agent_id, t.fact_key
  `);
  return result.rows;
}
