import { eq, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import { agentConsolidationSettings, type ConsolidationWeights } from "@/db/schema";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

// --- Env defaults (§5). All OFF / safe by default. ---

/** Master switch. Off = nothing runs. */
export function isMemoryConsolidationEnabled(env = process.env): boolean {
  return env.MEMORY_CONSOLIDATION_ENABLED?.trim().toLowerCase() === "true";
}

/** Compute + candidates, no proposals. */
export function isMemoryConsolidationDryRun(env = process.env): boolean {
  const raw = env.MEMORY_CONSOLIDATION_DRY_RUN?.trim().toLowerCase();
  return raw !== "false"; // default true unless explicitly disabled
}

/** Gates the narrow auto-apply class (§4.4). */
export function isMemoryConsolidationAutoApply(env = process.env): boolean {
  return env.MEMORY_CONSOLIDATION_AUTO_APPLY?.trim().toLowerCase() === "true";
}

/** Sweep schedule (pg-boss cron). Empty/absent = do not schedule. */
export function getMemoryConsolidationCron(env = process.env): string {
  return env.MEMORY_CONSOLIDATION_CRON?.trim() ?? "";
}

/** Debug logging in the worker. */
export function isMemoryConsolidationVerbose(env = process.env): boolean {
  return env.MEMORY_CONSOLIDATION_VERBOSE?.trim().toLowerCase() === "true";
}

/** Exposes the agent-facing memory_search tool (§10). Independent of the above. */
export function isMemorySearchEnabled(env = process.env): boolean {
  return env.MEMORY_SEARCH_ENABLED?.trim().toLowerCase() === "true";
}

// --- Scoring defaults (§4.2). Pure numbers; persisted as basis points. ---

/** Shipped weight defaults — the formula in scoring.ts (§4.2). */
export const DEFAULT_WEIGHTS: ConsolidationWeights = {
  relevance: 0.3,
  frequency: 0.24,
  diversity: 0.15,
  recency: 0.15,
  consistency: 0.1,
  concept: 0.06,
  phaseLightBoost: 0.06,
  phaseRemBoost: 0.09,
  recencyHalfLifeDays: 14,
};

export const DEFAULT_MIN_SCORE_BPS = 8000;
export const DEFAULT_MIN_RECALL_COUNT = 3;
export const DEFAULT_MIN_UNIQUE_QUERIES = 3;
export const DEFAULT_MAX_AGE_DAYS = 30;
/** Auto-apply requires score_bps ≥ 9000 (§4.4). */
export const AUTO_APPLY_MIN_SCORE_BPS = 9000;

/**
 * Effective config for an agent: env defaults merged with an optional
 * per-agent agent_consolidation_settings row (which wins when present). Mirrors
 * the lib/self-improvement/config.ts split. A missing settings row yields the
 * safe defaults (everything off / dry-run).
 */
export type ConsolidationConfig = {
  enabled: boolean;
  autoApplyEnabled: boolean;
  dryRun: boolean;
  minScoreBps: number;
  minRecallCount: number;
  minUniqueQueries: number;
  maxAgeDays: number;
  weights: ConsolidationWeights;
};

export async function getConsolidationConfig(
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<ConsolidationConfig> {
  // Env defaults are the baseline; the master switch must be on for anything
  // to run regardless of the per-agent row.
  const envEnabled = isMemoryConsolidationEnabled();
  const envAutoApply = isMemoryConsolidationAutoApply();
  const envDryRun = isMemoryConsolidationDryRun();

  const rows = await db
    .select()
    .from(agentConsolidationSettings)
    .where(eq(agentConsolidationSettings.agentId, agentId));

  const row = rows[0];
  if (!row) {
    return {
      enabled: envEnabled,
      autoApplyEnabled: envAutoApply,
      dryRun: envDryRun,
      minScoreBps: DEFAULT_MIN_SCORE_BPS,
      minRecallCount: DEFAULT_MIN_RECALL_COUNT,
      minUniqueQueries: DEFAULT_MIN_UNIQUE_QUERIES,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
      weights: DEFAULT_WEIGHTS,
    };
  }

  return {
    // The per-agent row wins when the global master switch is on; off globally
    // means off for everyone.
    enabled: envEnabled && row.enabled,
    autoApplyEnabled: envAutoApply && row.autoApplyEnabled,
    dryRun: row.dryRun,
    minScoreBps: row.minScoreBps,
    minRecallCount: row.minRecallCount,
    minUniqueQueries: row.minUniqueQueries,
    maxAgeDays: row.maxAgeDays,
    weights: row.weights ?? DEFAULT_WEIGHTS,
  };
}

/** Set / replace the per-agent settings row (upsert). */
export async function upsertConsolidationSettings(
  input: {
    agentId?: string;
    enabled?: boolean;
    autoApplyEnabled?: boolean;
    dryRun?: boolean;
    minScoreBps?: number;
    minRecallCount?: number;
    minUniqueQueries?: number;
    maxAgeDays?: number;
    weights?: ConsolidationWeights;
    updatedBy?: string;
  },
  db: AppDbClient = getDb(),
) {
  const agentId = input.agentId ?? DEFAULT_AGENT_ID;
  const value = {
    agentId,
    enabled: input.enabled,
    autoApplyEnabled: input.autoApplyEnabled,
    dryRun: input.dryRun,
    minScoreBps: input.minScoreBps,
    minRecallCount: input.minRecallCount,
    minUniqueQueries: input.minUniqueQueries,
    maxAgeDays: input.maxAgeDays,
    weights: input.weights,
    updatedAt: sql`now()`,
    updatedBy: input.updatedBy ?? null,
  };

  const inserted = await db
    .insert(agentConsolidationSettings)
    .values(value)
    .onConflictDoUpdate({
      target: agentConsolidationSettings.agentId,
      set: {
        enabled: sql`coalesce(excluded.enabled, ${agentConsolidationSettings.enabled})`,
        autoApplyEnabled: sql`coalesce(excluded.auto_apply_enabled, ${agentConsolidationSettings.autoApplyEnabled})`,
        dryRun: sql`coalesce(excluded.dry_run, ${agentConsolidationSettings.dryRun})`,
        minScoreBps: sql`coalesce(excluded.min_score_bps, ${agentConsolidationSettings.minScoreBps})`,
        minRecallCount: sql`coalesce(excluded.min_recall_count, ${agentConsolidationSettings.minRecallCount})`,
        minUniqueQueries: sql`coalesce(excluded.min_unique_queries, ${agentConsolidationSettings.minUniqueQueries})`,
        maxAgeDays: sql`coalesce(excluded.max_age_days, ${agentConsolidationSettings.maxAgeDays})`,
        weights: sql`coalesce(excluded.weights, ${agentConsolidationSettings.weights})`,
        updatedAt: sql`now()`,
        updatedBy: value.updatedBy,
      },
    })
    .returning();

  return inserted[0];
}
