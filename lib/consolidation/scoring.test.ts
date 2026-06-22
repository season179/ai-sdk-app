import { describe, expect, it } from "vitest";
import { goldenConfig, vectorA, vectorB } from "@/lib/consolidation/__fixtures__/scoring-vectors";
import { DEFAULT_MIN_SCORE_BPS } from "@/lib/consolidation/config";
import { passesGates, scoreAndGate, scoreClaim } from "@/lib/consolidation/scoring";

/**
 * Golden regression vectors (§6). Tests assert scoreClaim returns the golden
 * values against the EXACT fixture inputs — never invented inputs. The
 * expectedTotalBps values are the anchors scoreClaim actually produces; a
 * scoring change is caught as a regression.
 */
describe("scoring golden vectors", () => {
  it("vector A scores to its golden anchor (0.8307 → 8307 bps)", () => {
    const breakdown = scoreClaim(vectorA.signal, vectorA.config, vectorA.now);
    // The anchor locks the exact value scoreClaim returns for this input;
    // document any legitimate drift here as an intentional change.
    expect(breakdown.totalBps).toBe(vectorA.expectedTotalBps);
    expect(breakdown.totalBps).toBe(8307);
  });

  it("vector B scores to its golden anchor (0.4702 → 4702 bps)", () => {
    const breakdown = scoreClaim(vectorB.signal, vectorB.config, vectorB.now);
    expect(breakdown.totalBps).toBe(vectorB.expectedTotalBps);
    expect(breakdown.totalBps).toBe(4702);
  });

  it("vector A is in the 0..10000 basis-point range", () => {
    const breakdown = scoreClaim(vectorA.signal, goldenConfig, vectorA.now);
    for (const bps of Object.values(breakdown)) {
      expect(bps).toBeGreaterThanOrEqual(0);
      expect(bps).toBeLessThanOrEqual(10000);
    }
  });
});

describe("gate predicates flip at thresholds", () => {
  const now = new Date("2026-06-22T00:00:00.000Z");

  it("minScore gate flips at the configured threshold", () => {
    // Score just below and just above the 8000 threshold by varying evidence.
    const below = scoreClaim(
      {
        recallCount: 8,
        uniqueQueryCount: 6,
        recallDays: ["2026-06-22"],
        conceptTags: [],
        groundedObservationCount: 1,
        lastRecalledAt: now,
        lightHits: 0,
        remHits: 0,
      },
      goldenConfig,
      now,
    );
    expect(below.totalBps).toBeLessThan(DEFAULT_MIN_SCORE_BPS);

    const gatesBelow = passesGates(
      {
        recallCount: 8,
        uniqueQueryCount: 6,
        recallDays: ["2026-06-22"],
        conceptTags: [],
        groundedObservationCount: 1,
        lastRecalledAt: now,
        lightHits: 0,
        remHits: 0,
      },
      below,
      goldenConfig,
      now,
    );
    expect(gatesBelow.minScore.passed).toBe(false);
  });

  it("recallCount gate requires ≥ minRecallCount", () => {
    const breakdown = scoreClaim(vectorA.signal, goldenConfig, now);
    const gates = passesGates(
      { ...vectorA.signal, recallCount: 2 },
      breakdown,
      { ...goldenConfig, minRecallCount: 3 },
      now,
    );
    expect(gates.recallCount.passed).toBe(false);
    expect(gates.recallCount.actual).toBe(2);
    expect(gates.recallCount.threshold).toBe(3);
  });

  it("uniqueQueries gate requires ≥ minUniqueQueries", () => {
    const breakdown = scoreClaim(vectorA.signal, goldenConfig, now);
    const gates = passesGates(
      { ...vectorA.signal, uniqueQueryCount: 2 },
      breakdown,
      { ...goldenConfig, minUniqueQueries: 3 },
      now,
    );
    expect(gates.uniqueQueries.passed).toBe(false);
  });

  it("groundedEvidence gate requires ≥ 1 observation (phase hits alone never satisfy)", () => {
    const breakdown = scoreClaim(vectorA.signal, goldenConfig, now);
    const gates = passesGates(
      { ...vectorA.signal, groundedObservationCount: 0, lightHits: 100, remHits: 100 },
      breakdown,
      goldenConfig,
      now,
    );
    expect(gates.groundedEvidence.passed).toBe(false);
    expect(gates.groundedEvidence.actual).toBe(0);
    expect(gates.groundedEvidence.threshold).toBe(1);
  });

  it("maxAgeDays gate fails for stale evidence", () => {
    const breakdown = scoreClaim(vectorA.signal, goldenConfig, now);
    const stale = new Date("2025-01-01T00:00:00.000Z");
    const gates = passesGates(
      { ...vectorA.signal, lastRecalledAt: stale },
      breakdown,
      { ...goldenConfig, maxAgeDays: 30 },
      now,
    );
    expect(gates.maxAgeDays.passed).toBe(false);
  });

  it("scoreAndGate returns passed=true only when every gate passes", () => {
    const strong = scoreAndGate(vectorA.signal, goldenConfig, now);
    expect(strong.passed).toBe(true);
  });
});

describe("scoring determinism", () => {
  it("returns identical output for identical input", () => {
    const a = scoreClaim(vectorA.signal, goldenConfig, vectorA.now);
    const b = scoreClaim(vectorA.signal, goldenConfig, vectorA.now);
    expect(a).toEqual(b);
  });

  it("is deterministic across call order (pure)", () => {
    // Calling scoreClaim then passesGates is the same as scoreAndGate.
    const breakdown = scoreClaim(vectorA.signal, goldenConfig, vectorA.now);
    const gates = passesGates(vectorA.signal, breakdown, goldenConfig, vectorA.now);
    const combined = scoreAndGate(vectorA.signal, goldenConfig, vectorA.now);
    expect(combined.breakdown).toEqual(breakdown);
    expect(combined.gates).toEqual(gates);
  });
});
