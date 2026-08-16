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

/** One semantic claim identity across explicit, UI, and synthesized lanes. */
export function normalizeProfileClaim(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!?。！？]+$/u, "");
}

export function profileClaimHash(value: string): string {
  return sha256(normalizeProfileClaim(value));
}

export function stableFactKeyForClaim(value: string): string {
  return `claim-${profileClaimHash(value)}`;
}

export function reconcileProfile(
  snapshot: ProfileSynthesisSnapshot,
  extracted: ProfileExtractionOutput,
): ReconciledProfile {
  const tombstones = new Set(snapshot.tombstones.map((row) => row.factKey));
  const tombstonedClaims = new Set(snapshot.tombstones.map((row) => row.claimHash));
  const factMap = new Map<string, ProfileFactV1>();
  const sourceMap = new Map<string, ProfileSourceHandle[]>();
  const currentSourceMap = groupCurrentSources(snapshot);
  const activeMemoryByVersion = new Map(
    snapshot.activeMemories.map((memory) => [memory.memoryVersionId, memory]),
  );

  for (const fact of snapshot.currentVersion?.facts ?? []) {
    if (tombstones.has(fact.factKey) || tombstonedClaims.has(profileClaimHash(fact.sentence)))
      continue;
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
  const memoryById = new Map(
    [...snapshot.activeMemories, ...snapshot.memoryVersionDeltas].map((row) => [
      row.memoryVersionId,
      row,
    ]),
  );
  const operations = extracted.operations
    .map((operation) => ({
      operation,
      at: operationTime(operation, observationById, memoryById),
      tie: operationTieKey(operation),
    }))
    .sort((a, b) => compareEvidenceTuple(a.at, b.at) || a.tie.localeCompare(b.tie));

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
    if (tombstonedClaims.has(profileClaimHash(sentence))) continue;
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

    let factKey = allocateFactKey(sentence, factMap);
    if (tombstones.has(factKey) || tombstonedClaims.has(profileClaimHash(sentence))) continue;
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

function allocateFactKey(sentence: string, facts: ReadonlyMap<string, ProfileFactV1>): string {
  const stable = stableFactKeyForClaim(sentence);
  const existing = facts.get(stable);
  if (!existing || profileClaimHash(existing.sentence) === profileClaimHash(sentence))
    return stable;
  // A cryptographic collision fails closed rather than aliasing around identity.
  throw new Error("Profile claim hash collision.");
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

type EvidenceTuple = { at: string; id: string };

function operationTime(
  operation: ProfileExtractionOutput["operations"][number],
  observations: Map<string, ProfileSynthesisSnapshot["observationDeltas"][number]>,
  memories: Map<string, ProfileSynthesisSnapshot["activeMemories"][number]>,
): EvidenceTuple {
  const tuples = [
    ...operation.observationIds.flatMap((id) => {
      const row = observations.get(id);
      return row ? [{ at: row.createdAtText ?? row.createdAt.toISOString(), id: row.id }] : [];
    }),
    ...operation.memoryVersionIds.flatMap((id) => {
      const row = memories.get(id);
      return row
        ? [
            {
              at: row.createdAtText ?? row.createdAt.toISOString(),
              id: row.memoryVersionId,
            },
          ]
        : [];
    }),
  ];
  return tuples.reduce<EvidenceTuple>(
    (latest, value) => (compareEvidenceTuple(latest, value) < 0 ? value : latest),
    { at: "0000-01-01T00:00:00.000000Z", id: "" },
  );
}

function compareEvidenceTuple(a: EvidenceTuple, b: EvidenceTuple): number {
  return a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
}

function operationTieKey(operation: ProfileExtractionOutput["operations"][number]): string {
  return JSON.stringify({
    operation: operation.operation,
    targetFactKey: operation.targetFactKey ?? "",
    sentence: operation.sentence ?? "",
    category: operation.category ?? "",
    observationIds: [...operation.observationIds].sort(),
    memoryVersionIds: [...operation.memoryVersionIds].sort(),
  });
}

function normalizeSentence(value: string): string {
  return normalizeProfileClaim(value);
}
