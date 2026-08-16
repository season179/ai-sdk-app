import { sha256 } from "@/lib/memory/redaction";
import {
  getProfileMaxChars,
  getProfilePolicyVersion,
  getProfileSynthesisModel,
  getProfileTokenBudget,
} from "@/lib/profile/config";
import {
  extractProfileOperations,
  PROFILE_EXTRACTION_PROMPT_HASH,
  PROFILE_SYNTHESIZER_ID,
} from "@/lib/profile/extract";
import { reconcileProfile } from "@/lib/profile/reconcile";
import { PROFILE_RENDER_PROMPT_HASH, renderProfile, repairProfile } from "@/lib/profile/render";
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
    let lastConflict: ProfileGenerationConflictError | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const snapshot = await captureSynthesisSnapshot(agentId);
      try {
        return await synthesizeSnapshot(snapshot, options, options.model);
      } catch (error) {
        if (error instanceof ProfileGenerationConflictError) {
          lastConflict = error;
          if (attempt + 1 < attempts) continue;
        }
        throw error;
      }
    }
    throw lastConflict ?? new Error("Profile synthesis exhausted its attempts.");
  } catch (error) {
    await recordSynthesisFailure(agentId, error).catch(() => undefined);
    throw error;
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
  if (!hasSynthesisWork(snapshot)) {
    return commitNoop(snapshot, options.synthesisKey);
  }

  const synthesisModel = model ?? createOpenRouterProfileModel();
  // captureSynthesisSnapshot has committed before this model call starts.
  const extracted = await synthesisModel.extract(snapshot);
  const reconciled = reconcileProfile(snapshot, extracted);
  if (sameProjection(snapshot, reconciled.facts, reconciled.sources)) {
    return commitNoop(snapshot, options.synthesisKey);
  }

  const maxChars = getProfileMaxChars();
  const tokenBudget = getProfileTokenBudget();
  let body = await synthesisModel.render({
    facts: reconciled.facts,
    previousBody: snapshot.currentVersion?.body ?? "",
    maxChars,
    tokenBudget,
  });
  let validation = validateProfileCandidate({
    body,
    facts: reconciled.facts,
    sources: reconciled.sources,
    previousFacts: preservableCurrentFacts(snapshot),
    tombstones: snapshot.tombstones,
    maxChars,
  });
  if (!validation.valid) {
    // Exactly one repair pass. It may rewrite prose but never the manifest.
    body = await synthesisModel.repair({
      body,
      facts: reconciled.facts,
      issues: validation.issues,
      maxChars,
      tokenBudget,
    });
    validation = validateProfileCandidate({
      body,
      facts: reconciled.facts,
      sources: reconciled.sources,
      previousFacts: preservableCurrentFacts(snapshot),
      tombstones: snapshot.tombstones,
      maxChars,
    });
  }
  if (!validation.valid) {
    throw new Error(`Profile validation failed after repair: ${validation.issues.join(", ")}`);
  }

  return commitProfileVersion({
    agentId: snapshot.agentId,
    expectedVersionId: snapshot.expectedVersionId,
    expectedDirtyGeneration: snapshot.expectedDirtyGeneration,
    facts: reconciled.facts,
    sources: reconciled.sources,
    body,
    tokenCount: estimateTokens(body),
    trigger: options.trigger,
    authority: "synthesized",
    modelId: synthesisModel.modelId,
    promptHash: PROFILE_PROMPT_HASH,
    policyVersion: getProfilePolicyVersion(),
    upperBounds: snapshot.upperBounds,
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
  });
}

function hasSynthesisWork(snapshot: ProfileSynthesisSnapshot): boolean {
  if (snapshot.observationDeltas.length || snapshot.memoryVersionDeltas.length) return true;
  const currentKeys = new Set(snapshot.currentVersion?.facts.map((fact) => fact.factKey) ?? []);
  if (snapshot.tombstones.some((row) => currentKeys.has(row.factKey))) return true;
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
