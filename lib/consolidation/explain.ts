import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import {
  type AdmissionMetadata,
  agentConsolidationCandidates,
  agentConsolidationRuns,
  agentGroundedObservations,
  agentMemoryEvents,
  agentReviewProposals,
} from "@/db/schema";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/**
 * Human-readable score breakdown + gate reasons for the UI (§2 explain.ts).
 * Backs the dry-run preview and the per-item "why did/didn't this promote"
 * surface in /consolidation.
 */
export type CandidateExplanation = {
  candidate: {
    id: string;
    claimKey: string;
    snippet: string;
    scoreBps: number;
    passed: boolean;
    gateResults: NonNullable<(typeof agentConsolidationCandidates.$inferSelect)["gateResults"]>;
    proposalId: string | null;
    candidateOrigin: "signal" | "turn_review";
    sourceCandidateId: string | null;
    memoryType: "semantic" | "episodic" | "procedural" | null;
    evidenceTraceEventIds: string[];
    createdAt: string;
  };
  run: {
    id: string;
    status: string;
    trigger: string;
    startedAt: string;
    finishedAt: string | null;
  };
  observations: {
    id: string;
    originKind: string;
    content: string;
    createdAt: string;
  }[];
};

export async function explainCandidate(
  candidateId: string,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<CandidateExplanation | null> {
  const db = getDb();

  const candidateRows = await db
    .select()
    .from(agentConsolidationCandidates)
    .where(
      and(
        eq(agentConsolidationCandidates.id, candidateId),
        eq(agentConsolidationCandidates.agentId, agentId),
      ),
    )
    .limit(1);
  const candidate = candidateRows[0];
  if (!candidate) {
    return null;
  }

  const runRows = await db
    .select()
    .from(agentConsolidationRuns)
    .where(eq(agentConsolidationRuns.id, candidate.runId))
    .limit(1);
  const run = runRows[0];

  // The candidate row carries the score + gates, but the backing observation ids
  // live on the linked proposal's admissionMetadata (§1.1). Resolve them so the
  // "why did this promote" drawer can show the user-authored evidence.
  let observations: CandidateExplanation["observations"] = [];
  let evidenceTraceEventIds: string[] = [];
  if (candidate.proposalId) {
    const proposalRows = await db
      .select({ admissionMetadata: agentReviewProposals.admissionMetadata })
      .from(agentReviewProposals)
      .where(eq(agentReviewProposals.id, candidate.proposalId))
      .limit(1);
    const meta = proposalRows[0]?.admissionMetadata as AdmissionMetadata | null;
    const obsIds = meta?.version === 1 ? (meta.groundedObservationIds ?? []) : [];
    evidenceTraceEventIds = meta?.version === 2 ? meta.evidenceTraceEventIds : [];
    if (obsIds.length > 0) {
      const obsRows = await db
        .select({
          id: agentGroundedObservations.id,
          originKind: agentGroundedObservations.originKind,
          content: agentGroundedObservations.content,
          createdAt: agentGroundedObservations.createdAt,
        })
        .from(agentGroundedObservations)
        .where(
          and(
            eq(agentGroundedObservations.agentId, agentId),
            inArray(agentGroundedObservations.id, obsIds),
          ),
        )
        .orderBy(desc(agentGroundedObservations.createdAt));
      observations = obsRows.map((o) => ({
        id: o.id,
        originKind: o.originKind,
        content: o.content,
        createdAt: o.createdAt.toISOString(),
      }));
    }
  }

  return {
    candidate: {
      id: candidate.id,
      claimKey: candidate.claimKey,
      snippet: candidate.snippet,
      scoreBps: candidate.scoreBps,
      passed: candidate.passed,
      gateResults: candidate.gateResults ?? emptyGates(),
      proposalId: candidate.proposalId,
      candidateOrigin: candidate.candidateOrigin,
      sourceCandidateId: candidate.sourceCandidateId,
      memoryType: candidate.memoryType,
      evidenceTraceEventIds,
      createdAt: candidate.createdAt.toISOString(),
    },
    run: {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    observations,
  };
}

/** Recent runs for the /consolidation run feed. */
export async function listRecentRuns(agentId: string = DEFAULT_AGENT_ID, limit = 20) {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentConsolidationRuns)
    .where(eq(agentConsolidationRuns.agentId, agentId))
    .orderBy(desc(agentConsolidationRuns.startedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    observationsScanned: r.observationsScanned,
    candidatesEvaluated: r.candidatesEvaluated,
    candidatesPassed: r.candidatesPassed,
    proposalsCreated: r.proposalsCreated,
    error: r.error,
  }));
}

/** Candidates for a run, for the /consolidation candidate table. */
export async function listCandidatesForRun(runId: string, limit = 200) {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentConsolidationCandidates)
    .where(eq(agentConsolidationCandidates.runId, runId))
    .orderBy(desc(agentConsolidationCandidates.scoreBps))
    .limit(limit);
  return rows.map((c) => ({
    id: c.id,
    claimKey: c.claimKey,
    snippet: c.snippet,
    scoreBps: c.scoreBps,
    passed: c.passed,
    proposalId: c.proposalId,
    candidateOrigin: c.candidateOrigin,
    sourceCandidateId: c.sourceCandidateId,
    memoryType: c.memoryType,
    gateResults: c.gateResults ?? emptyGates(),
    createdAt: c.createdAt.toISOString(),
  }));
}

/**
 * Recent memory events — the timeline / "see the evolution" feed (§9.1). Human-
 * readable only; never re-enters evidence. Grouped by day client-side.
 */
export async function listRecentEvents(agentId: string = DEFAULT_AGENT_ID, limit = 100) {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentMemoryEvents)
    .where(eq(agentMemoryEvents.agentId, agentId))
    .orderBy(desc(agentMemoryEvents.createdAt))
    .limit(limit);
  return rows.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    origin: e.origin,
    summary: e.summary,
    memoryId: e.memoryId,
    memoryVersionId: e.memoryVersionId,
    proposalId: e.proposalId,
    runId: e.runId,
    detail: e.detail,
    createdAt: e.createdAt.toISOString(),
  }));
}

function emptyGates() {
  return {
    minScore: { passed: false, actualBps: 0, thresholdBps: 0 },
    recallCount: { passed: false, actual: 0, threshold: 0 },
    uniqueQueries: { passed: false, actual: 0, threshold: 0 },
    maxAgeDays: { passed: false, actual: 0, threshold: 0 },
    groundedEvidence: { passed: false, actual: 0, threshold: 1 as const },
  };
}
