import { sha256 } from "@/lib/memory/redaction";
import {
  getProfileMaxChars,
  getProfilePolicyVersion,
  getProfileSynthesisModel,
  getProfileTokenBudget,
} from "@/lib/profile/config";
import { renderCategorizedProfileText } from "@/lib/profile/context";
import {
  extractProfileOperations,
  PROFILE_EXTRACTION_PROMPT_HASH,
  PROFILE_SYNTHESIZER_ID,
} from "@/lib/profile/extract";
import { reconcileProfile } from "@/lib/profile/reconcile";
import {
  PROFILE_RENDER_PROMPT_HASH,
  renderProfile,
  repairProfile,
  selectFactsForRenderBudget,
} from "@/lib/profile/render";
import {
  captureSynthesisSnapshot,
  commitProfileNoop,
  commitProfileVersion,
  getSynthesisReceipt,
  ProfileGenerationConflictError,
  recordSynthesisFailure,
} from "@/lib/profile/repository";
import type {
  ProfileFactV1,
  ProfileSourceHandle,
  ProfileSynthesisModel,
  ProfileSynthesisResult,
  ProfileSynthesisSnapshot,
  SynthesisTrigger,
} from "@/lib/profile/types";
import { validateProfileCandidate } from "@/lib/profile/validate";
import { getPool } from "@/lib/scheduler/db";

export const PROFILE_PROMPT_HASH = sha256(
  `${PROFILE_EXTRACTION_PROMPT_HASH}:${PROFILE_RENDER_PROMPT_HASH}`,
);

export class MissingProfileSynthesisEnvError extends Error {
  constructor(readonly variableName: "OPENROUTER_API_KEY" | "AGENT_PROFILE_SYNTHESIS_MODEL") {
    super(`${variableName} is required for profile synthesis.`);
    this.name = "MissingProfileSynthesisEnvError";
  }
}

export type SynthesizeProfileOptions = {
  trigger: SynthesisTrigger;
  synthesisKey: string;
  maxAttempts?: number;
  model?: ProfileSynthesisModel;
};

export async function synthesizeProfile(
  agentId: string,
  options: SynthesizeProfileOptions,
): Promise<ProfileSynthesisResult> {
  const lockKey = `${agentId}:${PROFILE_SYNTHESIZER_ID}`;
  const client = await getPool().connect();
  await client.query("select pg_advisory_lock(hashtext($1))", [lockKey]);
  try {
    const receipt = await getSynthesisReceipt(
      agentId,
      options.synthesisKey,
      PROFILE_SYNTHESIZER_ID,
    );
    if (receipt) return receipt;

    const attempts = Math.max(1, Math.min(2, options.maxAttempts ?? 1));
    let conflictAttempts = 0;
    for (let batch = 0; batch < 1_000; ) {
      const snapshot = await captureSynthesisSnapshot(agentId);
      const expectation = {
        versionId: snapshot.expectedVersionId,
        dirtyGeneration: snapshot.expectedDirtyGeneration,
      };
      const synthesisKey = snapshot.hasMoreEvidence
        ? `${options.synthesisKey}:batch:${snapshot.synthesizedGeneration}-${snapshot.processedGeneration}`
        : options.synthesisKey;
      try {
        const result = await synthesizeSnapshot(
          snapshot,
          { ...options, synthesisKey },
          options.model,
        );
        if (!snapshot.hasMoreEvidence) return result;
        batch += 1;
        conflictAttempts = 0;
      } catch (error) {
        if (error instanceof ProfileGenerationConflictError && conflictAttempts + 1 < attempts) {
          conflictAttempts += 1;
          continue;
        }
        await recordSynthesisFailure(agentId, error, expectation).catch(() => undefined);
        throw error;
      }
    }
    throw new Error("Profile synthesis exceeded the bounded evidence batch limit.");
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
    client.release();
  }
}

async function synthesizeSnapshot(
  snapshot: ProfileSynthesisSnapshot,
  options: SynthesizeProfileOptions,
  model: ProfileSynthesisModel | undefined,
): Promise<ProfileSynthesisResult> {
  if (!hasSynthesisWork(snapshot)) return commitNoop(snapshot, options.synthesisKey);

  const synthesisModel = model ?? createOpenRouterProfileModel();
  // captureSynthesisSnapshot has committed before every model call.
  const extracted = await synthesisModel.extract(snapshot);
  const reconciled = reconcileProfile(snapshot, extracted);
  const maxChars = getProfileMaxChars();
  const tokenBudget = getProfileTokenBudget();
  const facts = selectFactsForRenderBudget(reconciled.facts, maxChars, tokenBudget);
  const keptKeys = new Set(facts.map((fact) => fact.factKey));
  const sources = reconciled.sources.filter((source) => keptKeys.has(source.factKey));
  if (sameProjection(snapshot, facts, sources)) return commitNoop(snapshot, options.synthesisKey);

  // Rendering is deterministic because the reconciled fact manifest is already
  // the validated model output. This normalizes provider markdown, heading, and
  // truncation variance before the strict safety/provenance validator.
  const body = renderCategorizedProfileText(facts);
  const validation = validateProfileCandidate({
    body,
    facts,
    sources,
    previousFacts: preservableCurrentFacts(snapshot),
    tombstones: snapshot.tombstones,
    maxChars,
  });
  if (!validation.valid) {
    throw new Error(`Deterministic profile validation failed: ${validation.issues.join(", ")}`);
  }

  return commitProfileVersion({
    agentId: snapshot.agentId,
    expectedVersionId: snapshot.expectedVersionId,
    expectedDirtyGeneration: snapshot.expectedDirtyGeneration,
    facts,
    sources,
    body,
    tokenCount: estimateTokens(body),
    trigger: options.trigger,
    authority: "synthesized",
    modelId: synthesisModel.modelId,
    promptHash: PROFILE_PROMPT_HASH,
    policyVersion: getProfilePolicyVersion(),
    upperBounds: snapshot.upperBounds,
    processedGeneration: snapshot.processedGeneration,
    receipt: {
      synthesisKey: options.synthesisKey,
      synthesizerId: PROFILE_SYNTHESIZER_ID,
      lowerBounds: snapshot.lowerBounds,
    },
  });
}

function commitNoop(snapshot: ProfileSynthesisSnapshot, synthesisKey: string) {
  return commitProfileNoop({
    agentId: snapshot.agentId,
    expectedVersionId: snapshot.expectedVersionId,
    expectedDirtyGeneration: snapshot.expectedDirtyGeneration,
    lowerBounds: snapshot.lowerBounds,
    upperBounds: snapshot.upperBounds,
    synthesisKey,
    synthesizerId: PROFILE_SYNTHESIZER_ID,
    processedGeneration: snapshot.processedGeneration,
  });
}

function hasSynthesisWork(snapshot: ProfileSynthesisSnapshot): boolean {
  if (snapshot.observationDeltas.length || snapshot.memoryVersionDeltas.length) return true;
  const currentKeys = new Set(snapshot.currentVersion?.facts.map((fact) => fact.factKey) ?? []);
  if (
    snapshot.tombstones.some(
      (row) =>
        currentKeys.has(row.factKey) ||
        snapshot.currentVersion?.facts.some(
          (fact) => sha256(normalizeClaim(fact.sentence)) === row.claimHash,
        ),
    )
  ) {
    return true;
  }
  const factsByKey = new Map(
    snapshot.currentVersion?.facts.map((fact) => [fact.factKey, fact]) ?? [],
  );
  for (const source of snapshot.currentSources) {
    const fact = factsByKey.get(source.factKey);
    if (!source.live && fact?.authority !== "user" && !fact?.protected) return true;
  }
  const activeMemoryById = new Map(
    snapshot.activeMemories.map((memory) => [memory.memoryVersionId, memory]),
  );
  for (const fact of factsByKey.values()) {
    const citedMemories = snapshot.currentSources.flatMap((source) => {
      if (source.factKey !== fact.factKey || !source.memoryVersionId) return [];
      const memory = activeMemoryById.get(source.memoryVersionId);
      return memory ? [memory] : [];
    });
    if (citedMemories.length === 0) continue;
    if (fact.protected !== citedMemories.some((memory) => memory.protected)) return true;
    if (
      fact.authority !== "user" &&
      citedMemories.some((memory) => memory.source === "user" || memory.authority === "user")
    ) {
      return true;
    }
  }
  return (
    snapshot.expectedDirtyGeneration > snapshot.synthesizedGeneration &&
    snapshot.activeMemories.length > 0
  );
}

function preservableCurrentFacts(snapshot: ProfileSynthesisSnapshot): ProfileFactV1[] {
  const liveKeys = new Set(
    snapshot.currentSources.filter((source) => source.live).map((source) => source.factKey),
  );
  return (snapshot.currentVersion?.facts ?? []).filter(
    (fact) => (fact.authority === "user" || fact.protected) && liveKeys.has(fact.factKey),
  );
}

function sameProjection(
  snapshot: ProfileSynthesisSnapshot,
  facts: ProfileFactV1[],
  sources: ProfileSourceHandle[],
): boolean {
  if (!snapshot.currentVersion) return facts.length === 0;
  const currentSources = snapshot.currentSources.map(
    ({ live: _live, occurredAt: _at, ...source }) => source,
  );
  return (
    stableJson(snapshot.currentVersion.facts) === stableJson(facts) &&
    stableJson(sortSources(currentSources)) === stableJson(sortSources(sources))
  );
}

function sortSources(sources: ProfileSourceHandle[]) {
  return [...sources].sort((a, b) =>
    `${a.factKey}:${a.traceEventId ?? ""}:${a.memoryVersionId ?? ""}`.localeCompare(
      `${b.factKey}:${b.traceEventId ?? ""}:${b.memoryVersionId ?? ""}`,
    ),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeClaim(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!?。！？]+$/u, "");
}

function estimateTokens(body: string): number {
  return body ? Math.max(1, Math.ceil([...body].length / 4)) : 0;
}

function createOpenRouterProfileModel(): ProfileSynthesisModel {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new MissingProfileSynthesisEnvError("OPENROUTER_API_KEY");
  const model = getProfileSynthesisModel();
  if (!model) throw new MissingProfileSynthesisEnvError("AGENT_PROFILE_SYNTHESIS_MODEL");
  return {
    modelId: model,
    extract: (snapshot) => extractProfileOperations(snapshot, { apiKey, model }),
    render: (input) => renderProfile(input, { apiKey, model, tokenBudget: input.tokenBudget }),
    repair: (input) => repairProfile(input, { apiKey, model, tokenBudget: input.tokenBudget }),
  };
}
