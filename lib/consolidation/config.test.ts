import { describe, expect, it } from "vitest";

import { DEFAULT_WEIGHTS, parseConsolidationWeights } from "@/lib/consolidation/config";
import { SelfImprovementInputError } from "@/lib/self-improvement/errors";

/**
 * Weights validation (I1). The scorer multiplies raw weights by 0..1 components;
 * a missing/NaN/oversized weight would corrupt scoring silently. parseConsolidationWeights
 * is the gatekeeper for operator-supplied weights (PUT /api/consolidation/settings).
 */

describe("parseConsolidationWeights", () => {
  it("returns undefined for nullish input (caller keeps defaults)", () => {
    expect(parseConsolidationWeights(undefined)).toBeUndefined();
    expect(parseConsolidationWeights(null)).toBeUndefined();
  });

  it("fills missing fields with shipped defaults", () => {
    const w = parseConsolidationWeights({ relevance: 0.5 });
    expect(w?.relevance).toBe(0.5);
    expect(w?.frequency).toBe(DEFAULT_WEIGHTS.frequency);
    expect(w?.recencyHalfLifeDays).toBe(DEFAULT_WEIGHTS.recencyHalfLifeDays);
  });

  it("accepts all valid weight fields", () => {
    const w = parseConsolidationWeights({
      relevance: 0.4,
      frequency: 0.2,
      diversity: 0.1,
      recency: 0.1,
      consistency: 0.1,
      concept: 0.05,
      phaseLightBoost: 0.05,
      phaseRemBoost: 0.08,
      recencyHalfLifeDays: 21,
    });
    expect(w).toMatchObject({ relevance: 0.4, recencyHalfLifeDays: 21 });
  });

  it("rejects a weight outside 0..1", () => {
    expect(() => parseConsolidationWeights({ relevance: 1.5 })).toThrow(SelfImprovementInputError);
    expect(() => parseConsolidationWeights({ frequency: -0.1 })).toThrow(SelfImprovementInputError);
  });

  it("rejects a non-numeric weight", () => {
    expect(() => parseConsolidationWeights({ relevance: "high" })).toThrow(
      SelfImprovementInputError,
    );
  });

  it("rejects values Number() would silently coerce (boolean, array, empty string)", () => {
    // true→1, []→0, ""→0 would all pass a bare Number()+range check; each must throw.
    expect(() => parseConsolidationWeights({ relevance: true })).toThrow(SelfImprovementInputError);
    expect(() => parseConsolidationWeights({ relevance: [] })).toThrow(SelfImprovementInputError);
    expect(() => parseConsolidationWeights({ relevance: "" })).toThrow(SelfImprovementInputError);
    expect(() => parseConsolidationWeights({ recencyHalfLifeDays: true })).toThrow(
      SelfImprovementInputError,
    );
  });

  it("rejects recencyHalfLifeDays ≤ 0", () => {
    expect(() => parseConsolidationWeights({ recencyHalfLifeDays: 0 })).toThrow(
      SelfImprovementInputError,
    );
    expect(() => parseConsolidationWeights({ recencyHalfLifeDays: -5 })).toThrow(
      SelfImprovementInputError,
    );
  });

  it("accepts a boundary recencyHalfLifeDays", () => {
    expect(parseConsolidationWeights({ recencyHalfLifeDays: 1 })?.recencyHalfLifeDays).toBe(1);
  });

  it("rejects an unknown key (typo guard)", () => {
    expect(() => parseConsolidationWeights({ relevence: 0.5 })).toThrow(SelfImprovementInputError);
  });

  it("rejects a non-object input", () => {
    expect(() => parseConsolidationWeights("nope")).toThrow(SelfImprovementInputError);
    expect(() => parseConsolidationWeights([])).toThrow(SelfImprovementInputError);
  });
});
