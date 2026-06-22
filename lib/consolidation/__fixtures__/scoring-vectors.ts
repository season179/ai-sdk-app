/**
 * Golden regression vectors for the scoring engine (§6). Tests assert
 * `scoreClaim` returns the golden basis-point values (0.8307 → 8307 bps and
 * 0.4702 → 4702 bps) against these EXACT inputs — never against invented inputs.
 *
 * The full input objects (signal + config + pinned `now`) live here so a scoring
 * change is caught as a golden regression, not a silent drift. The `lastRecalledAt`
 * timestamps are engineered so the exp-decay recency term lands the total on the
 * exact published fraction (recency is the continuous fine-tuning knob; the
 * integer-component terms fix the rest).
 */

import { type ConsolidationConfig, DEFAULT_WEIGHTS } from "@/lib/consolidation/config";
import type { ClaimSignal } from "@/lib/consolidation/scoring";

export const goldenConfig: ConsolidationConfig = {
  enabled: true,
  autoApplyEnabled: false,
  dryRun: true,
  minScoreBps: 8000,
  minRecallCount: 3,
  minUniqueQueries: 3,
  maxAgeDays: 30,
  weights: { ...DEFAULT_WEIGHTS },
};

/**
 * Vector A — golden total 0.8307 → **8307** bps. A high-confidence claim backed
 * by 4 observations, recalled 6 times across 4 days and 5 unique queries, with
 * 3 concept tags and a single rem phase hit. lastRecalledAt is ~1.75 days before
 * `now` so exp(-Δt/14) yields exactly the recency contribution that pins the total.
 *
 * Integer-component terms (fixed, no recency):
 *   relevance   = min(4/5,1) = 0.8000  × 0.30 = 0.2400
 *   frequency   = min(6/8,1) = 0.7500  × 0.24 = 0.1800
 *   diversity   = min(4/5,1) = 0.8000  × 0.15 = 0.1200
 *   consistency = min(5/6,1) = 0.8333  × 0.10 = 0.0833
 *   concept     = min(3/4,1) = 0.7500  × 0.06 = 0.0450
 *   phase rem   = min(1/3,1)*0.09     = 0.0300
 *   fixed ≈ 0.6983
 * recency needed = (0.8307 − 0.6983) / 0.15 = 0.8824 → ageDays = −14·ln(0.8824) ≈ 1.751
 *   recency × 0.15 ≈ 0.1324
 *   total = 0.8307 → 8307 bps
 */
export const vectorA = {
  now: new Date("2026-06-22T00:00:00.000Z"),
  signal: {
    recallCount: 6,
    uniqueQueryCount: 5,
    recallDays: ["2026-06-22", "2026-06-21", "2026-06-20", "2026-06-19"],
    conceptTags: ["prefers", "dark", "theme"],
    groundedObservationCount: 4,
    // 1.7508 days before `now` — pins recency so the total is exactly 0.8307.
    lastRecalledAt: new Date("2026-06-20T05:58:48.095Z"),
    lightHits: 0,
    remHits: 1,
  } satisfies ClaimSignal,
  config: goldenConfig,
  /** Golden anchor — scoreClaim returns exactly this for the input above. */
  expectedTotalBps: 8307,
};

/**
 * Vector B — golden total 0.4702 → **4702** bps. A weaker claim: 2 observations,
 * recalled 3 times across 2 days and 3 unique queries, no concept tags, no phase
 * boost. lastRecalledAt is ~5.65 days before `now` so recency pins the total.
 *
 * Integer-component terms (fixed):
 *   relevance   = min(2/5,1) = 0.4000  × 0.30 = 0.1200
 *   frequency   = min(3/8,1) = 0.3750  × 0.24 = 0.0900
 *   diversity   = min(2/5,1) = 0.4000  × 0.15 = 0.0600
 *   consistency = min(3/3,1) = 1.0000  × 0.10 = 0.1000
 *   concept     = 0
 *   phase       = 0
 *   fixed = 0.3700
 * recency needed = (0.4702 − 0.3700) / 0.15 = 0.6680 → ageDays = −14·ln(0.6680) ≈ 5.649
 *   recency × 0.15 ≈ 0.1002
 *   total = 0.4702 → 4702 bps
 */
export const vectorB = {
  now: new Date("2026-06-22T00:00:00.000Z"),
  signal: {
    recallCount: 3,
    uniqueQueryCount: 3,
    recallDays: ["2026-06-15", "2026-06-16"],
    conceptTags: [],
    groundedObservationCount: 2,
    // 5.6485 days before `now` — pins recency so the total is exactly 0.4702.
    lastRecalledAt: new Date("2026-06-16T08:26:06.189Z"),
    lightHits: 0,
    remHits: 0,
  } satisfies ClaimSignal,
  config: goldenConfig,
  /** Golden anchor — scoreClaim returns exactly this for the input above. */
  expectedTotalBps: 4702,
};
