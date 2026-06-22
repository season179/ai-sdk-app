import type { ConsolidationConfig } from "@/lib/consolidation/config";

/**
 * Pure, deterministic scoring + gate predicates (§4.2, §4.3). No DB, no I/O.
 * Internally computes in basis points (§0.5) and returns integers in 0..10000.
 * Golden-tested against the vectors in __fixtures__/scoring-vectors.ts.
 *
 * Formula (§4.2):
 *   score = 0.30·relevance + 0.24·frequency + 0.15·diversity + 0.15·recency
 *         + 0.10·consistency + 0.06·concept + phase_boost
 *   recency uses exp(-Δt / halfLife), half-life 14 days
 *   phase_boost: light ≤ 0.06, rem ≤ 0.09, capped
 */

/** The machine-state input to the scorer — one normalized claim's evidence. */
export type ClaimSignal = {
  recallCount: number;
  uniqueQueryCount: number;
  // Distinct UTC days the claim was recalled (diversity signal).
  recallDays: string[];
  // Concept tags (the `concept` component).
  conceptTags: string[];
  // Number of grounded observations backing the claim (§4.3 gate).
  groundedObservationCount: number;
  // Most recent observation/recall timestamp (recency signal).
  lastRecalledAt: Date;
  // Phase boosts (§4.2): bounded hit counts.
  lightHits: number;
  remHits: number;
};

export type ScoreBreakdown = {
  relevanceBps: number;
  frequencyBps: number;
  diversityBps: number;
  recencyBps: number;
  consistencyBps: number;
  conceptBps: number;
  phaseBoostBps: number;
  totalBps: number;
};

export type GateResults = {
  minScore: { passed: boolean; actualBps: number; thresholdBps: number };
  recallCount: { passed: boolean; actual: number; threshold: number };
  uniqueQueries: { passed: boolean; actual: number; threshold: number };
  maxAgeDays: { passed: boolean; actual: number; threshold: number };
  groundedEvidence: { passed: boolean; actual: number; threshold: 1 };
};

export type ScoredClaim = {
  breakdown: ScoreBreakdown;
  gates: GateResults;
  passed: boolean;
};

const BPS_MAX = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

function clampBps(n: number): number {
  return Math.max(0, Math.min(BPS_MAX, Math.round(n)));
}

/**
 * Score a single claim. Pure and deterministic. `now` is injected so golden
 * vectors can pin recency; the runtime passes `new Date()`.
 */
export function scoreClaim(
  signal: ClaimSignal,
  cfg: ConsolidationConfig,
  now: Date = new Date(),
): ScoreBreakdown {
  const w = cfg.weights;

  // relevance: grounded evidence density — more observations = more relevant.
  // Saturates at ~5 observations.
  const relevance = Math.min(1, signal.groundedObservationCount / 5);

  // frequency: recall count saturating at ~8.
  const frequency = Math.min(1, signal.recallCount / 8);

  // diversity: distinct recall days saturating at ~5.
  const diversity = Math.min(1, signal.recallDays.length / 5);

  // recency: exponential decay, half-life from config (default 14 days).
  const ageDays = Math.max(0, (now.getTime() - signal.lastRecalledAt.getTime()) / DAY_MS);
  const recency = Math.exp(-ageDays / Math.max(1, w.recencyHalfLifeDays));

  // consistency: ratio of unique queries to recalls — high when the claim is
  // recalled consistently across queries rather than spammy. Guards divide-by-0.
  const consistency =
    signal.recallCount > 0 ? Math.min(1, signal.uniqueQueryCount / signal.recallCount) : 0;

  // concept: presence of concept tags saturating at ~4 distinct tags.
  const concept = Math.min(1, signal.conceptTags.length / 4);

  // phase_boost: bounded caps. light ≤ phaseLightBoost, rem ≤ phaseRemBoost,
  // each saturating at ~3 hits. Can never satisfy gates alone (§4.2).
  const lightBoost = Math.min(1, signal.lightHits / 3) * w.phaseLightBoost;
  const remBoost = Math.min(1, signal.remHits / 3) * w.phaseRemBoost;
  const phaseBoostRaw = lightBoost + remBoost;

  const total =
    w.relevance * relevance +
    w.frequency * frequency +
    w.diversity * diversity +
    w.recency * recency +
    w.consistency * consistency +
    w.concept * concept +
    phaseBoostRaw;

  return {
    relevanceBps: clampBps(relevance * BPS_MAX),
    frequencyBps: clampBps(frequency * BPS_MAX),
    diversityBps: clampBps(diversity * BPS_MAX),
    recencyBps: clampBps(recency * BPS_MAX),
    consistencyBps: clampBps(consistency * BPS_MAX),
    conceptBps: clampBps(concept * BPS_MAX),
    phaseBoostBps: clampBps(phaseBoostRaw * BPS_MAX),
    totalBps: clampBps(total * BPS_MAX),
  };
}

/**
 * Gate predicates (§4.3). ALL must pass to propose. Phase hits alone can never
 * satisfy the grounded-evidence gate (it requires ≥ 1 observation).
 */
export function passesGates(
  signal: ClaimSignal,
  breakdown: ScoreBreakdown,
  cfg: ConsolidationConfig,
  now: Date = new Date(),
): GateResults {
  const ageDays = Math.max(0, (now.getTime() - signal.lastRecalledAt.getTime()) / DAY_MS);

  const minScore = {
    passed: breakdown.totalBps >= cfg.minScoreBps,
    actualBps: breakdown.totalBps,
    thresholdBps: cfg.minScoreBps,
  };
  const recallCount = {
    passed: signal.recallCount >= cfg.minRecallCount,
    actual: signal.recallCount,
    threshold: cfg.minRecallCount,
  };
  const uniqueQueries = {
    passed: signal.uniqueQueryCount >= cfg.minUniqueQueries,
    actual: signal.uniqueQueryCount,
    threshold: cfg.minUniqueQueries,
  };
  const maxAgeDays = {
    passed: ageDays <= cfg.maxAgeDays,
    actual: Math.round(ageDays),
    threshold: cfg.maxAgeDays,
  };
  const groundedEvidence = {
    passed: signal.groundedObservationCount >= 1,
    actual: signal.groundedObservationCount,
    threshold: 1 as const,
  };

  return { minScore, recallCount, uniqueQueries, maxAgeDays, groundedEvidence };
}

/** Convenience: score + gate in one call. */
export function scoreAndGate(
  signal: ClaimSignal,
  cfg: ConsolidationConfig,
  now: Date = new Date(),
): ScoredClaim {
  const breakdown = scoreClaim(signal, cfg, now);
  const gates = passesGates(signal, breakdown, cfg, now);
  const passed = Object.values(gates).every((g) => g.passed);
  return { breakdown, gates, passed };
}
