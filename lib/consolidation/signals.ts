import { eq, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  type AgentGroundedObservation,
  agentPhaseSignals,
  agentRecallSignals,
  type ConsolidationWeights,
  type NewAgentPhaseSignal,
  type NewAgentRecallSignal,
} from "@/db/schema";
import { claimHash, conceptTags, normalizeClaim } from "@/lib/consolidation/normalize";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/**
 * Evidence accumulation (§2 signals.ts). Updates recall + phase signals from
 * grounded observations and manages the incremental checkpoint. Recall signals
 * are machine state — NEVER read into the prompt.
 *
 * A "claim" here is a normalized-content bucket: observations sharing the same
 * claim_hash roll up into one recall signal. recall_count tracks how many
 * grounded observations back the claim; unique_query_count tracks distinct
 * query hashes (a proxy for cross-session diversity); recall_days tracks
 * distinct UTC days.
 */

export type RecallSignalRow = {
  id: string;
  claimKey: string;
  claimHash: string;
  snippet: string;
  groundedObservationIds: string[];
  recallCount: number;
  uniqueQueryCount: number;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
  totalScoreBps: number;
  maxScoreBps: number;
  firstRecalledAt: Date | null;
  lastRecalledAt: Date | null;
};

/**
 * Group grounded observations into per-claim buckets keyed by claim_hash. Each
 * bucket becomes one recall signal. Observations with no content are skipped.
 *
 * Because runConsolidation scans the FULL observation set each sweep, a bucket
 * fully determines its signal — so the derived fields (observationIds,
 * recallCount, queryHashes, recallDays, conceptTags) are recomputed here from
 * the complete bucket, not accumulated incrementally. This keeps the signal
 * idempotent and reproducible across sweeps (§4.2 determinism).
 *
 * `queryHashes` / `uniqueQueryCount` derive cross-session diversity (§1.2): each
 * distinct source session (chat) or source memory (memory_user) that contributed
 * an observation counts as one "query". A claim seen in 3 separate sessions has
 * uniqueQueryCount=3.
 */
export function groupByClaim(observations: AgentGroundedObservation[]): {
  claimHash: string;
  claimKey: string;
  snippet: string;
  observationIds: string[];
  queryHashes: string[];
  uniqueQueryCount: number;
  recallDays: string[];
  lastSeenAt: Date;
  firstSeenAt: Date;
  tags: string[];
}[] {
  const buckets = new Map<
    string,
    {
      claimKey: string;
      snippet: string;
      observationIds: string[];
      queryKeys: Set<string>;
      days: Set<string>;
      lastSeenAt: Date;
      firstSeenAt: Date;
      tags: Set<string>;
    }
  >();

  for (const obs of observations) {
    const key = normalizeClaim(obs.content);
    if (!key) {
      continue;
    }
    // claimHash is already computed/stored on the observation; recompute to be
    // safe (cheap, deterministic).
    const hash = claimHash(obs.content);
    // The "query" identity: the session that produced a chat observation, or
    // the source memory for a memory_user observation. Distinct values here are
    // the cross-session diversity signal.
    const queryKey = obs.sessionId ?? obs.sourceMemoryId ?? obs.id;
    const day = obs.createdAt.toISOString().slice(0, 10);

    const bucket = buckets.get(hash);
    if (bucket) {
      bucket.observationIds.push(obs.id);
      bucket.queryKeys.add(queryKey);
      bucket.days.add(day);
      bucket.tags = new Set([...bucket.tags, ...conceptTags(obs.content)]);
      if (obs.createdAt > bucket.lastSeenAt) {
        bucket.lastSeenAt = obs.createdAt;
        bucket.snippet = obs.content.slice(0, 200);
      }
      if (obs.createdAt < bucket.firstSeenAt) {
        bucket.firstSeenAt = obs.createdAt;
      }
    } else {
      buckets.set(hash, {
        claimKey: key,
        snippet: obs.content.slice(0, 200),
        observationIds: [obs.id],
        queryKeys: new Set([queryKey]),
        days: new Set([day]),
        lastSeenAt: obs.createdAt,
        firstSeenAt: obs.createdAt,
        tags: new Set(conceptTags(obs.content)),
      });
    }
  }

  return Array.from(buckets.entries()).map(([claimHash, b]) => {
    const queryHashes = Array.from(b.queryKeys);
    return {
      claimHash,
      claimKey: b.claimKey,
      snippet: b.snippet,
      observationIds: b.observationIds,
      queryHashes,
      uniqueQueryCount: queryHashes.length,
      recallDays: Array.from(b.days).sort(),
      lastSeenAt: b.lastSeenAt,
      firstSeenAt: b.firstSeenAt,
      tags: Array.from(b.tags),
    };
  });
}

/**
 * Upsert a recall signal for one claim bucket. Idempotent via the
 * (agent_id, claim_hash) unique index. Because runConsolidation scans the FULL
 * observation set each sweep, the input bucket fully determines the signal, so
 * the conflict path OVERWRITES the derived fields rather than accumulating
 * them. This keeps recallCount/uniqueQueryCount/etc. stable across sweeps
 * (§4.2 determinism) — additive accumulation would double-count every sweep.
 */
export async function upsertRecallSignal(
  input: {
    agentId?: string;
    claimKey: string;
    claimHash: string;
    snippet: string;
    observationIds: string[];
    queryHashes: string[];
    uniqueQueryCount: number;
    recallDays: string[];
    firstSeenAt: Date;
    lastSeenAt: Date;
    tags: string[];
  },
  db: AppDbClient = getDb(),
): Promise<RecallSignalRow> {
  const agentId = input.agentId ?? DEFAULT_AGENT_ID;

  const value: NewAgentRecallSignal = {
    agentId,
    claimKey: input.claimKey,
    claimHash: input.claimHash,
    snippet: input.snippet,
    groundedObservationIds: input.observationIds,
    recallCount: input.observationIds.length,
    uniqueQueryCount: input.uniqueQueryCount,
    queryHashes: input.queryHashes,
    recallDays: input.recallDays,
    conceptTags: input.tags,
    totalScoreBps: 0,
    maxScoreBps: 0,
    firstRecalledAt: input.firstSeenAt,
    lastRecalledAt: input.lastSeenAt,
  };

  // on conflict, OVERWRITE the derived fields with the freshly recomputed
  // bucket (the full scan re-sees the same observations, so the values are
  // identical or have grown by new observations only). Scores are reset to 0
  // here and re-recorded by recordScore in the run loop.
  const inserted = await db
    .insert(agentRecallSignals)
    .values(value)
    .onConflictDoUpdate({
      target: [agentRecallSignals.agentId, agentRecallSignals.claimHash],
      set: {
        groundedObservationIds: sql`excluded.grounded_observation_ids`,
        recallCount: sql`excluded.recall_count`,
        uniqueQueryCount: sql`excluded.unique_query_count`,
        queryHashes: sql`excluded.query_hashes`,
        recallDays: sql`excluded.recall_days`,
        conceptTags: sql`excluded.concept_tags`,
        lastRecalledAt: sql`excluded.last_recalled_at`,
        firstRecalledAt: sql`excluded.first_recalled_at`,
        snippet: excludedSnippet(),
        updatedAt: sql`now()`,
      },
    })
    .returning();

  const row = inserted[0];
  return mapRecallSignalRow(row);
}

function excludedSnippet() {
  // Prefer the newer snippet when its row is later.
  return sql`case
    when excluded.last_recalled_at >= ${agentRecallSignals.lastRecalledAt}
    then excluded.snippet
    else ${agentRecallSignals.snippet}
  end`;
}

/** Read all recall signals for an agent (the consolidation scan input). */
export async function listRecallSignals(
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<RecallSignalRow[]> {
  const rows = await db
    .select()
    .from(agentRecallSignals)
    .where(eq(agentRecallSignals.agentId, agentId));
  return rows.map(mapRecallSignalRow);
}

/** Persist the computed score onto a recall signal (totalScoreBps, maxScoreBps). */
export async function recordScore(
  signalId: string,
  totalScoreBps: number,
  maxScoreBps: number,
  db: AppDbClient = getDb(),
): Promise<void> {
  await db
    .update(agentRecallSignals)
    .set({
      totalScoreBps,
      maxScoreBps: Math.max(maxScoreBps, totalScoreBps),
      updatedAt: sql`now()`,
    })
    .where(eq(agentRecallSignals.id, signalId));
}

// --- Phase signals (§4.2) ---

export async function recordPhaseHit(
  claimKey: string,
  phase: "light" | "rem",
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<void> {
  const value: NewAgentPhaseSignal = {
    agentId,
    claimKey,
    lightHits: phase === "light" ? 1 : 0,
    remHits: phase === "rem" ? 1 : 0,
    lastLightAt: phase === "light" ? new Date() : null,
    lastRemAt: phase === "rem" ? new Date() : null,
  };

  await db
    .insert(agentPhaseSignals)
    .values(value)
    .onConflictDoUpdate({
      target: [agentPhaseSignals.agentId, agentPhaseSignals.claimKey],
      set: {
        lightHits:
          phase === "light" ? sql`${agentPhaseSignals.lightHits} + 1` : agentPhaseSignals.lightHits,
        remHits:
          phase === "rem" ? sql`${agentPhaseSignals.remHits} + 1` : agentPhaseSignals.remHits,
        lastLightAt: phase === "light" ? sql`now()` : agentPhaseSignals.lastLightAt,
        lastRemAt: phase === "rem" ? sql`now()` : agentPhaseSignals.lastRemAt,
        updatedAt: sql`now()`,
      },
    });
}

export async function listPhaseSignals(
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<Map<string, { lightHits: number; remHits: number }>> {
  const rows = await db
    .select({
      claimKey: agentPhaseSignals.claimKey,
      lightHits: agentPhaseSignals.lightHits,
      remHits: agentPhaseSignals.remHits,
    })
    .from(agentPhaseSignals)
    .where(eq(agentPhaseSignals.agentId, agentId));

  const map = new Map<string, { lightHits: number; remHits: number }>();
  for (const row of rows) {
    map.set(row.claimKey, { lightHits: row.lightHits, remHits: row.remHits });
  }
  return map;
}

function mapRecallSignalRow(row: {
  id: string;
  claimKey: string;
  claimHash: string;
  snippet: string;
  groundedObservationIds: string[];
  recallCount: number;
  uniqueQueryCount: number;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
  totalScoreBps: number;
  maxScoreBps: number;
  firstRecalledAt: Date | null;
  lastRecalledAt: Date | null;
}): RecallSignalRow {
  return {
    id: row.id,
    claimKey: row.claimKey,
    claimHash: row.claimHash,
    snippet: row.snippet,
    groundedObservationIds: row.groundedObservationIds,
    recallCount: row.recallCount,
    uniqueQueryCount: row.uniqueQueryCount,
    queryHashes: row.queryHashes,
    recallDays: row.recallDays,
    conceptTags: row.conceptTags,
    totalScoreBps: row.totalScoreBps,
    maxScoreBps: row.maxScoreBps,
    firstRecalledAt: row.firstRecalledAt,
    lastRecalledAt: row.lastRecalledAt,
  };
}

// re-export for type-only consumers
export type { ConsolidationWeights };
