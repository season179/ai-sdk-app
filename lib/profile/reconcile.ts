import { sha256 } from "@/lib/memory/redaction";
import type {
  ProfileExtractionOutput,
  ProfileFactCategory,
  ProfileFactV1,
  ProfileSourceHandle,
  ProfileSynthesisSnapshot,
  ReconciledProfile,
} from "@/lib/profile/types";

const CATEGORY_ORDER: ProfileFactCategory[] = [
  "identity_context",
  "preferences_constraints",
  "active_projects_goals",
  "interaction_instructions",
];

export function normalizeStableFactKey(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
    .replace(/-+$/g, "");
  return normalized || `fact-${sha256(value).slice(0, 12)}`;
}

export function reconcileProfile(
  snapshot: ProfileSynthesisSnapshot,
  extracted: ProfileExtractionOutput,
): ReconciledProfile {
  const tombstones = new Set(snapshot.tombstones.map((row) => row.factKey));
  const factMap = new Map<string, ProfileFactV1>();
  const sourceMap = new Map<string, ProfileSourceHandle[]>();
  const currentSourceMap = groupCurrentSources(snapshot);
  const activeMemoryByVersion = new Map(
    snapshot.activeMemories.map((memory) => [memory.memoryVersionId, memory]),
  );

  for (const fact of snapshot.currentVersion?.facts ?? []) {
    if (tombstones.has(fact.factKey)) continue;
    const sources = currentSourceMap.get(fact.factKey) ?? [];
    const liveSources = sources.filter((source) => source.live).map(stripSourceState);
    const citedActiveMemories = sources.flatMap((source) => {
      const memory = source.memoryVersionId
        ? activeMemoryByVersion.get(source.memoryVersionId)
        : undefined;
      return memory ? [memory] : [];
    });
    const carriedFact = {
      ...fact,
      authority: citedActiveMemories.some(
        (memory) => memory.source === "user" || memory.authority === "user",
      )
        ? ("user" as const)
        : fact.authority,
      protected:
        citedActiveMemories.length > 0
          ? citedActiveMemories.some((memory) => memory.protected)
          : fact.protected,
    };
    if ((carriedFact.authority === "user" || carriedFact.protected) && liveSources.length > 0) {
      factMap.set(fact.factKey, carriedFact);
      sourceMap.set(fact.factKey, liveSources);
    } else if (liveSources.length > 0) {
      factMap.set(fact.factKey, carriedFact);
      sourceMap.set(fact.factKey, liveSources);
    }
  }

  const observationById = new Map(snapshot.observationDeltas.map((row) => [row.id, row]));
  const memoryById = new Map(snapshot.activeMemories.map((row) => [row.memoryVersionId, row]));
  const operations = extracted.operations
    .map((operation, index) => ({
      operation,
      index,
      at: operationTime(operation, observationById, memoryById),
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index);

  for (const { operation } of operations) {
    const target = operation.targetFactKey ? factMap.get(operation.targetFactKey) : undefined;
    if (operation.operation === "invalidate") {
      if (target && target.authority !== "user" && !target.protected) {
        factMap.delete(target.factKey);
        sourceMap.delete(target.factKey);
      }
      continue;
    }
    if (!operation.sentence || !operation.category) continue;
    const sentence = operation.sentence;
    const category = operation.category;
    const sources = operationSources(
      operation.observationIds,
      operation.memoryVersionIds,
      observationById,
      memoryById,
    );
    if (sources.length === 0) continue;
    const citedMemories = operation.memoryVersionIds.flatMap((id) => {
      const memory = memoryById.get(id);
      return memory ? [memory] : [];
    });
    const userAuthority = citedMemories.some(
      (memory) => memory.active && (memory.source === "user" || memory.authority === "user"),
    );
    const protectedFact = citedMemories.some((memory) => memory.active && memory.protected);

    if (operation.operation === "update") {
      if (
        !target ||
        target.authority === "user" ||
        target.protected ||
        tombstones.has(target.factKey)
      )
        continue;
      factMap.set(target.factKey, {
        factKey: target.factKey,
        sentence,
        category,
        authority: userAuthority ? "user" : "synthesized",
        protected: protectedFact,
        order: target.order,
      });
      sourceMap.set(
        target.factKey,
        sources.map((source) => ({ ...source, factKey: target.factKey })),
      );
      continue;
    }

    let factKey = allocateFactKey(sentence, category, factMap, tombstones);
    if (tombstones.has(factKey)) continue;
    const duplicate = [...factMap.values()].find(
      (fact) => normalizeSentence(fact.sentence) === normalizeSentence(sentence),
    );
    if (duplicate) {
      if (duplicate.authority === "user" || duplicate.protected) continue;
      factKey = duplicate.factKey;
    }
    factMap.set(factKey, {
      factKey,
      sentence,
      category,
      authority: userAuthority ? "user" : "synthesized",
      protected: protectedFact,
      order: 0,
    });
    sourceMap.set(
      factKey,
      sources.map((source) => ({ ...source, factKey })),
    );
  }

  for (const key of tombstones) {
    factMap.delete(key);
    sourceMap.delete(key);
  }

  const facts = [...factMap.values()]
    .sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
        Number(b.authority === "user") - Number(a.authority === "user") ||
        Number(b.protected) - Number(a.protected) ||
        a.order - b.order ||
        a.factKey.localeCompare(b.factKey),
    )
    .map((fact, order) => ({ ...fact, order }));
  const retainedKeys = new Set(facts.map((fact) => fact.factKey));
  const sources = facts
    .flatMap((fact) => dedupeSources(sourceMap.get(fact.factKey) ?? []))
    .filter((source) => retainedKeys.has(source.factKey));
  return { facts, sources };
}

function allocateFactKey(
  sentence: string,
  category: ProfileFactCategory,
  facts: ReadonlyMap<string, ProfileFactV1>,
  tombstones: ReadonlySet<string>,
): string {
  const base = normalizeStableFactKey(`${category}-${sentence}`);
  if (!facts.has(base) && !tombstones.has(base)) return base;
  for (let index = 0; index < 100; index += 1) {
    const candidate = `${base.slice(0, 186)}-${sha256(`${sentence}:${index}`).slice(0, 12)}`;
    if (!facts.has(candidate) && !tombstones.has(candidate)) return candidate;
  }
  return `${base.slice(0, 186)}-${sha256(sentence).slice(0, 12)}`;
}

function groupCurrentSources(snapshot: ProfileSynthesisSnapshot) {
  const grouped = new Map<string, ProfileSynthesisSnapshot["currentSources"]>();
  for (const source of snapshot.currentSources) {
    const rows = grouped.get(source.factKey) ?? [];
    rows.push(source);
    grouped.set(source.factKey, rows);
  }
  return grouped;
}

function stripSourceState(
  source: ProfileSynthesisSnapshot["currentSources"][number],
): ProfileSourceHandle {
  return {
    factKey: source.factKey,
    sourceRole: source.sourceRole,
    traceEventId: source.traceEventId,
    memoryVersionId: source.memoryVersionId,
  };
}

function operationSources(
  observationIds: string[],
  memoryIds: string[],
  observations: Map<string, ProfileSynthesisSnapshot["observationDeltas"][number]>,
  memories: Map<string, ProfileSynthesisSnapshot["activeMemories"][number]>,
): ProfileSourceHandle[] {
  return [
    ...observationIds.flatMap((id) => {
      const row = observations.get(id);
      return row
        ? [
            {
              factKey: "",
              sourceRole: "primary" as const,
              traceEventId: row.traceEventId,
              memoryVersionId: null,
            },
          ]
        : [];
    }),
    ...memoryIds.flatMap((id) => {
      const row = memories.get(id);
      return row
        ? [
            {
              factKey: "",
              sourceRole: "primary" as const,
              traceEventId: null,
              memoryVersionId: row.memoryVersionId,
            },
          ]
        : [];
    }),
  ];
}

function dedupeSources(sources: ProfileSourceHandle[]): ProfileSourceHandle[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.factKey}:${source.traceEventId ?? ""}:${source.memoryVersionId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function operationTime(
  operation: ProfileExtractionOutput["operations"][number],
  observations: Map<string, ProfileSynthesisSnapshot["observationDeltas"][number]>,
  memories: Map<string, ProfileSynthesisSnapshot["activeMemories"][number]>,
): Date {
  const times = [
    ...operation.observationIds.flatMap((id) => {
      const row = observations.get(id);
      return row ? [row.createdAt] : [];
    }),
    ...operation.memoryVersionIds.flatMap((id) => {
      const row = memories.get(id);
      return row ? [row.createdAt] : [];
    }),
  ];
  return times.reduce((latest, value) => (value > latest ? value : latest), new Date(0));
}

function normalizeSentence(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}
