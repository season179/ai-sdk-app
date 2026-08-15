import type { MemoryKind } from "@/db/schema";
import type { GeneralRecallItem, RecallScoreComponents } from "@/lib/memory/types";

export const RRF_K = 60;
export const LEXICAL_WEIGHT = 0.65;
export const TRIGRAM_WEIGHT = 0.35;
export const MAX_RRF = (LEXICAL_WEIGHT + TRIGRAM_WEIGHT) / (RRF_K + 1);

export type RankFeatures = {
  lexicalRank?: number | null;
  trigramRank?: number | null;
  importance: number;
  confidence: number;
  kind: MemoryKind;
  eventDate?: Date | string | null;
  asOf: Date;
  riskPenalty?: number;
};

export function weightedRrf(lexicalRank?: number | null, trigramRank?: number | null): number {
  return (
    (lexicalRank ? LEXICAL_WEIGHT / (RRF_K + lexicalRank) : 0) +
    (trigramRank ? TRIGRAM_WEIGHT / (RRF_K + trigramRank) : 0)
  );
}

export function normalizeRrf(rrf: number): number {
  return clamp01(rrf / MAX_RRF);
}

export function freshnessForKind(
  kind: MemoryKind | "decision",
  eventDate: Date | string | null | undefined,
  asOf: Date,
): number {
  if (
    kind === "decision" ||
    kind === "preference" ||
    kind === "correction" ||
    kind === "persona" ||
    kind === "procedure"
  ) {
    return 1;
  }

  const halfLifeDays = kind === "episode" ? 90 : 180;
  const eventMs = eventDate ? new Date(eventDate).getTime() : asOf.getTime();
  if (!Number.isFinite(eventMs)) return 0;
  const ageDays = Math.max(0, (asOf.getTime() - eventMs) / 86_400_000);
  return 2 ** (-ageDays / halfLifeDays);
}

export function scoreFeatures(features: RankFeatures): RecallScoreComponents {
  const rrf = weightedRrf(features.lexicalRank, features.trigramRank);
  const normalizedRrf = normalizeRrf(rrf);
  const importance = clamp01(features.importance / 100);
  const confidence = clamp01(features.confidence / 100);
  const freshness = freshnessForKind(features.kind, features.eventDate, features.asOf);
  const riskPenalty = Math.max(0, Math.min(0.3, features.riskPenalty ?? 0));
  const composite =
    0.65 * normalizedRrf + 0.15 * importance + 0.1 * confidence + 0.1 * freshness - riskPenalty;

  return {
    lexicalRank: features.lexicalRank ?? null,
    trigramRank: features.trigramRank ?? null,
    rrf,
    normalizedRrf,
    importance,
    confidence,
    freshness,
    riskPenalty,
    composite,
  };
}

export function compareGeneralRecall(a: GeneralRecallItem, b: GeneralRecallItem): number {
  return (
    b.score.composite - a.score.composite ||
    b.score.rrf - a.score.rrf ||
    new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime() ||
    a.versionId.localeCompare(b.versionId)
  );
}

/**
 * Defense-in-depth after the current-pointer SQL gate. A memory root is one
 * lineage in the landed schema; exact normalized content also collapses an
 * accidentally duplicated root. The highest-ranked current item wins.
 */
export function dedupeGeneralRecall(items: GeneralRecallItem[]): GeneralRecallItem[] {
  const ranked = [...items].sort(compareGeneralRecall);
  const memoryIds = new Set<string>();
  const contentKeys = new Set<string>();

  return ranked.filter((item) => {
    if (memoryIds.has(item.lineageId) || contentKeys.has(item.contentKey)) return false;
    memoryIds.add(item.lineageId);
    contentKeys.add(item.contentKey);
    return true;
  });
}

export function contentDedupeKey(content: string): string {
  return content.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
