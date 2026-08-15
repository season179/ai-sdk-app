import { eq, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  type AdmissionMetadataV1,
  type AdmissionMetadataV2,
  agentConsolidationCandidates,
  agentConsolidationRuns,
  type ConsolidationRunStatus,
  type ConsolidationTrigger,
} from "@/db/schema";
import {
  evaluateAutoApply,
  maybeAutoApplyConsolidation,
  stampAutoApply,
} from "@/lib/consolidation/auto-apply";
import {
  getConsolidationConfig,
  isMemoryConsolidationAutoApply,
  isMemoryConsolidationEnabled,
} from "@/lib/consolidation/config";
import { recordMemoryEvent } from "@/lib/consolidation/events";
import { listGroundedObservations } from "@/lib/consolidation/observations";
import { proposeCandidate, proposeTypedCandidate } from "@/lib/consolidation/propose";
import type { PersistedCandidateVerdict } from "@/lib/memory/candidates";
import { type ClaimSignal, scoreAndGate } from "@/lib/consolidation/scoring";
import {
  groupByClaim,
  listPhaseSignals,
  listRecallSignals,
  recordScore,
  upsertRecallSignal,
} from "@/lib/consolidation/signals";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/**
 * Orchestrate one consolidation sweep (§2 run.ts): scan observations → group
 * into claims → upsert recall signals → score → gate → write candidates →
 * (proposals, unless dry-run).
 *
 * Produces a run row + candidate rows. In dry-run (default), NO proposals are
 * created. Candidates are written for every scored claim (passed or not) so the
 * /consolidation explain-why surface can show what didn't promote and why.
 */
export async function admitTurnReviewCandidates(
  input: {
    agentId: string;
    candidates: PersistedCandidateVerdict[];
  },
  db: AppDbClient = getDb(),
): Promise<{ runId: string; accepted: number; rejected: number; proposed: number }> {
  const cfg = await getConsolidationConfig(input.agentId, db);
  const [run] = await db
    .insert(agentConsolidationRuns)
    .values({ agentId: input.agentId, status: "running", trigger: "turn_review" })
    .returning();
  let accepted = 0;
  let rejected = 0;
  let proposed = 0;

  for (const item of input.candidates) {
    const passed = item.candidate.gateStatus === "accepted";
    if (passed) accepted += 1;
    else rejected += 1;
    const [row] = await db
      .insert(agentConsolidationCandidates)
      .values({
        runId: run.id,
        agentId: input.agentId,
        claimKey: item.candidate.canonicalKey ?? `candidate:${item.candidate.id}`,
        snippet: passed ? (item.candidate.content ?? "") : `[rejected:${item.candidate.gateReason}]`,
        candidateOrigin: "turn_review",
        sourceCandidateId: item.candidate.id,
        memoryType: item.candidate.memoryType,
        scoreBps: item.candidate.scoreBps,
        gateResults: null,
        passed,
      })
      .onConflictDoNothing()
      .returning();

    if (!passed || cfg.dryRun) continue;
    const structured = item.candidate.structured as Record<string, unknown>;
    const proposedKind =
      typeof structured.memoryKind === "string" &&
      ["preference", "fact", "correction", "persona", "episode", "procedure"].includes(
        structured.memoryKind,
      )
        ? (structured.memoryKind as AdmissionMetadataV2["memoryKind"])
        : item.candidate.memoryType === "episodic"
          ? "episode"
          : item.candidate.memoryType === "procedural"
            ? "procedure"
            : "fact";
    const range = item.candidate.validDuring;
    const [validFrom, validTo] = parseTstzRange(range);
    const metadata: AdmissionMetadataV2 = {
      version: 2,
      origin: "turn_review",
      sourceCandidateId: item.candidate.id,
      evidenceTraceEventIds: item.evidenceTraceEventIds,
      memoryType: item.candidate.memoryType,
      memoryKind: proposedKind,
      proposedOperation: item.candidate.proposedOperation,
      sourceStance: item.candidate.sourceStance,
      scoreBps: item.candidate.scoreBps,
      gateStatus: item.candidate.gateStatus,
      gateReason: item.candidate.gateReason,
      canonicalKey: item.candidate.canonicalKey,
      validFrom,
      validTo,
      timePrecision: item.candidate.timePrecision,
      dryRun: false,
    };
    const proposal = await proposeTypedCandidate(
      {
        agentId: input.agentId,
        sourceCandidateId: item.candidate.id,
        memoryType: item.candidate.memoryType,
        content: item.candidate.content ?? "",
        canonicalKey: item.candidate.canonicalKey,
        confidence: item.candidate.confidence,
        validFrom,
        validTo,
        metadata,
        runId: run.id,
      },
      db,
    );
    proposed += 1;
    if (row) {
      await db
        .update(agentConsolidationCandidates)
        .set({ proposalId: proposal.id })
        .where(eq(agentConsolidationCandidates.id, row.id));
    }
  }

  await db
    .update(agentConsolidationRuns)
    .set({
      status: "completed",
      finishedAt: sql`now()`,
      observationsScanned: 0,
      candidatesEvaluated: input.candidates.length,
      candidatesPassed: accepted,
      proposalsCreated: proposed,
    })
    .where(eq(agentConsolidationRuns.id, run.id));
  return { runId: run.id, accepted, rejected, proposed };
}

export function parseTstzRange(value: string | null): [string | null, string | null] {
  if (!value) return [null, null];
  const match = /^\[([^,]*),([^)]*)\)$/.exec(value);
  if (!match) throw new Error("Malformed tstzrange returned for a memory candidate.");
  const parseBound = (raw: string): string | null => {
    if (!raw) return null;
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    const timestamp = Date.parse(unquoted);
    if (Number.isNaN(timestamp)) throw new Error("Invalid tstzrange bound returned for a memory candidate.");
    return new Date(timestamp).toISOString();
  };
  return [parseBound(match[1]), parseBound(match[2])];
}

export async function runConsolidation(
  agentId: string = DEFAULT_AGENT_ID,
  opts: { trigger?: ConsolidationTrigger; db?: AppDbClient } = {},
): Promise<{
  runId: string;
  observationsScanned: number;
  candidatesEvaluated: number;
  candidatesPassed: number;
  proposalsCreated: number;
}> {
  const trigger: ConsolidationTrigger = opts.trigger ?? "scheduled";
  const db = opts.db ?? getDb();
  const cfg = await getConsolidationConfig(agentId, db);

  // Create the run row as 'running'.
  const runRows = await db
    .insert(agentConsolidationRuns)
    .values({ agentId, status: "running" as ConsolidationRunStatus, trigger })
    .returning();
  const run = runRows[0];

  try {
    // 1. Scan grounded observations (the firewall tier — never derivative content).
    const observations = await listGroundedObservations(agentId, undefined, db);

    // 2. Group into per-claim buckets and upsert recall signals. Because the
    //    scan is full (not incremental), groupByClaim derives the complete
    //    signal per claim — observationIds, queryHashes (distinct source
    //    sessions/memories), recallDays (distinct UTC days) — so the upsert is
    //    a deterministic recompute, not an accumulation.
    const buckets = groupByClaim(observations);
    for (const bucket of buckets) {
      await upsertRecallSignal(
        {
          agentId,
          claimKey: bucket.claimKey,
          claimHash: bucket.claimHash,
          snippet: bucket.snippet,
          observationIds: bucket.observationIds,
          queryHashes: bucket.queryHashes,
          uniqueQueryCount: bucket.uniqueQueryCount,
          recallDays: bucket.recallDays,
          firstSeenAt: bucket.firstSeenAt,
          lastSeenAt: bucket.lastSeenAt,
          tags: bucket.tags,
        },
        db,
      );
    }

    // 3. Re-read recall signals (now merged) + phase signals, then score + gate.
    const signals = await listRecallSignals(agentId, db);
    const phase = await listPhaseSignals(agentId, db);
    // Use the resolved per-agent config, not the raw env flag: getConsolidationConfig
    // merges the agent_consolidation_settings row over the env default, so an
    // operator toggling dryRun in the settings UI actually takes effect.
    const dryRun = cfg.dryRun;
    const now = new Date();

    // 4. Insert ALL candidates first (passed or not), proposalId null. The
    //    explain-why surface reads these regardless of outcome.
    type ScoredCandidate = {
      signalId: string;
      claimKey: string;
      snippet: string;
      scoreBps: number;
      gates: AdmissionMetadataV1["gates"];
      passed: boolean;
      metadata: AdmissionMetadataV1;
    };
    const scored: ScoredCandidate[] = [];

    for (const signal of signals) {
      const phaseHits = phase.get(signal.claimKey) ?? { lightHits: 0, remHits: 0 };
      const claimSignal: ClaimSignal = {
        recallCount: signal.recallCount,
        uniqueQueryCount: signal.uniqueQueryCount,
        recallDays: signal.recallDays,
        conceptTags: signal.conceptTags,
        groundedObservationCount: signal.groundedObservationIds.length,
        lastRecalledAt: signal.lastRecalledAt ?? now,
        lightHits: phaseHits.lightHits,
        remHits: phaseHits.remHits,
      };

      const result = scoreAndGate(claimSignal, cfg, now);
      await recordScore(signal.id, result.breakdown.totalBps, signal.maxScoreBps, db);

      const metadata: AdmissionMetadataV1 = {
        version: 1,
        origin: "consolidation",
        claimKey: signal.claimKey,
        claimHash: signal.claimHash,
        scoreBps: result.breakdown.totalBps,
        score: {
          relevanceBps: result.breakdown.relevanceBps,
          frequencyBps: result.breakdown.frequencyBps,
          diversityBps: result.breakdown.diversityBps,
          recencyBps: result.breakdown.recencyBps,
          consistencyBps: result.breakdown.consistencyBps,
          conceptBps: result.breakdown.conceptBps,
          phaseBoostBps: result.breakdown.phaseBoostBps,
          totalBps: result.breakdown.totalBps,
        },
        gates: result.gates,
        groundedObservationIds: signal.groundedObservationIds,
        dryRun,
      };

      scored.push({
        signalId: signal.id,
        claimKey: signal.claimKey,
        snippet: signal.snippet,
        scoreBps: result.breakdown.totalBps,
        gates: result.gates,
        passed: result.passed,
        metadata,
      });
    }

    const candidateRows = scored.map((s) => ({
      runId: run.id,
      agentId,
      claimKey: s.claimKey,
      snippet: s.snippet,
      scoreBps: s.scoreBps,
      gateResults: s.gates,
      passed: s.passed,
      proposalId: null,
    }));

    let insertedIds: { id: string }[] = [];
    if (candidateRows.length > 0) {
      insertedIds = await db
        .insert(agentConsolidationCandidates)
        .values(candidateRows)
        .returning({ id: agentConsolidationCandidates.id });
    }

    // 5. For passed, non-dry-run candidates: create proposals and link them.
    let candidatesPassed = 0;
    let proposalsCreated = 0;
    const globalEnabled = isMemoryConsolidationEnabled();
    const globalAutoApply = isMemoryConsolidationAutoApply();
    for (let i = 0; i < scored.length; i++) {
      const s = scored[i];
      if (!s.passed || dryRun) {
        continue;
      }
      candidatesPassed += 1;
      const candidateId = insertedIds[i]?.id;
      // Stamp the auto-apply eligibility (§4.4) onto the admission metadata so
      // the review UI can show why a proposal will/won't auto-apply. This is a
      // best-effort UI hint over the static clauses; the DB-backed clauses
      // (existing claim_hash, protected) are re-checked authoritatively at apply
      // time by maybeAutoApplyConsolidation. hasExistingClaimHash/isProtected
      // default false here because they are unknown until apply.
      const autoApplyDecision = evaluateAutoApply({
        globalEnabled,
        globalAutoApply,
        perAgentAutoApplyEnabled: cfg.autoApplyEnabled,
        admissionPolicy: "auto_apply_low_risk",
        kind: "memory_create",
        scoreBps: s.scoreBps,
        hasExistingClaimHash: false,
        isProtected: false,
      });
      const stampedMetadata = stampAutoApply({ ...s.metadata, candidateId }, autoApplyDecision);
      const proposal = await proposeCandidate(
        {
          agentId,
          claimKey: s.claimKey,
          snippet: s.snippet,
          metadata: stampedMetadata,
          runId: run.id,
        },
        db,
      );
      proposalsCreated += 1;
      // Link the proposal back onto the candidate row.
      if (candidateId) {
        await db
          .update(agentConsolidationCandidates)
          .set({ proposalId: proposal.id })
          .where(eq(agentConsolidationCandidates.id, candidateId));
      }
      // §4.4: if the proposal was admitted to the auto-apply lane, attempt the
      // auto-apply now. The full predicate is re-checked inside; a failing
      // clause routes to human review (no-op here). A duplicate claim_hash race
      // is caught and logged as duplicate_claim_hash (no-op). Fail-soft so a
      // single auto-apply miss never fails the whole sweep.
      if (proposal.admissionPolicy === "auto_apply_low_risk") {
        await maybeAutoApplyConsolidation(
          { agentId, proposal, perAgentAutoApplyEnabled: cfg.autoApplyEnabled },
          db,
        ).catch((error) => {
          console.error("Auto-apply failed for proposal", proposal.id, error);
        });
      }
    }

    // 6. Finalize the run.
    await db
      .update(agentConsolidationRuns)
      .set({
        status: "completed",
        finishedAt: sql`now()`,
        observationsScanned: observations.length,
        candidatesEvaluated: signals.length,
        candidatesPassed,
        proposalsCreated,
      })
      .where(eq(agentConsolidationRuns.id, run.id));

    // 7. Timeline event (human-facing only; never re-enters evidence).
    await recordMemoryEvent({
      agentId,
      eventType: "consolidation_run",
      origin: "consolidation",
      summary: `Consolidation ${trigger} run: ${observations.length} obs, ${signals.length} candidates, ${proposalsCreated} proposals${dryRun ? " (dry-run)" : ""}.`,
      runId: run.id,
    });

    return {
      runId: run.id,
      observationsScanned: observations.length,
      candidatesEvaluated: signals.length,
      candidatesPassed,
      proposalsCreated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(agentConsolidationRuns)
      .set({ status: "failed", finishedAt: sql`now()`, error: message })
      .where(eq(agentConsolidationRuns.id, run.id))
      .catch(() => undefined);
    throw error;
  }
}
