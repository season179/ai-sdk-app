import { describe, expect, it } from "vitest";

import {
  contentDedupeKey,
  dedupeGeneralRecall,
  freshnessForKind,
  normalizeRrf,
  scoreFeatures,
  weightedRrf,
} from "@/lib/memory/ranking";
import type { GeneralRecallItem } from "@/lib/memory/types";

const AS_OF = new Date("2026-01-01T00:00:00.000Z");

describe("recall ranking", () => {
  it("uses weighted RRF with k=60 and theoretical-max normalization", () => {
    expect(weightedRrf(1, 1)).toBeCloseTo(1 / 61, 12);
    expect(weightedRrf(1, null)).toBeCloseTo(0.65 / 61, 12);
    expect(normalizeRrf(weightedRrf(1, 1))).toBe(1);
  });

  it("combines bounded normalized features with the documented weights", () => {
    const score = scoreFeatures({
      lexicalRank: 1,
      trigramRank: 1,
      importance: 80,
      confidence: 70,
      kind: "fact",
      eventDate: AS_OF,
      asOf: AS_OF,
    });
    expect(score.composite).toBeCloseTo(0.65 + 0.12 + 0.07 + 0.1, 12);
  });

  it("does not decay decisions, preferences, or procedures", () => {
    const old = "2000-01-01T00:00:00.000Z";
    expect(freshnessForKind("decision", old, AS_OF)).toBe(1);
    expect(freshnessForKind("preference", old, AS_OF)).toBe(1);
    expect(freshnessForKind("procedure", old, AS_OF)).toBe(1);
  });

  it("applies kind-specific half lives", () => {
    const ninetyDaysAgo = new Date(AS_OF.getTime() - 90 * 86_400_000);
    const oneEightyDaysAgo = new Date(AS_OF.getTime() - 180 * 86_400_000);
    expect(freshnessForKind("episode", ninetyDaysAgo, AS_OF)).toBeCloseTo(0.5, 12);
    expect(freshnessForKind("fact", oneEightyDaysAgo, AS_OF)).toBeCloseTo(0.5, 12);
  });

  it("dedupes lineage and exact normalized content while keeping the best rank", () => {
    const items = [
      memory("b", "lineage", "Same  content", 0.4),
      memory("a", "lineage", "older", 0.8),
      memory("c", "other", " same content ", 0.6),
    ];
    expect(dedupeGeneralRecall(items).map((item) => item.versionId)).toEqual(["a", "c"]);
    expect(contentDedupeKey(" SAME\ncontent ")).toBe(contentDedupeKey("same content"));
  });

  it("uses stable version id for exact ties and is deterministic", () => {
    const items = [memory("z", "z-lineage", "z", 0.5), memory("a", "a-lineage", "a", 0.5)];
    const first = dedupeGeneralRecall(items).map((item) => item.versionId);
    expect(first).toEqual(["a", "z"]);
    expect(dedupeGeneralRecall(items).map((item) => item.versionId)).toEqual(first);
  });
});

function memory(
  versionId: string,
  lineageId: string,
  content: string,
  composite: number,
): GeneralRecallItem {
  return {
    category: "memory",
    id: lineageId,
    versionId,
    lineageId,
    type: "fact",
    memoryType: "semantic",
    sourceKind: "user",
    summary: content,
    status: "approved",
    eventDate: "2025-01-01T00:00:00.000Z",
    validDate: null,
    provenanceTraceIds: [],
    authority: "user",
    confidence: 80,
    contentKey: contentDedupeKey(content),
    score: {
      lexicalRank: 1,
      trigramRank: null,
      rrf: 0.01,
      normalizedRrf: 0.61,
      importance: 0.5,
      confidence: 0.8,
      freshness: 1,
      riskPenalty: 0,
      composite,
    },
  };
}
