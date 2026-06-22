import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  agentConsolidationCandidates,
  agentConsolidationRuns,
  agentGroundedObservations,
  agentMemoryEvents,
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

  // Resolve the backing observations from the gate metadata's evidence ids.
  const gateResults = candidate.gateResults;
  void gateResults;

  // The candidate row itself doesn't carry groundedObservationIds (those live
  // on the recall signal / admission metadata on the proposal). Fetch from the
  // proposal's admissionMetadata if linked, else return empty.
  const observations: CandidateExplanation["observations"] = [];
  if (candidate.proposalId) {
    // Lightweight: pull observations via the proposal's admission metadata is
    // a join too far for explain; the UI renders the metadata breakdown directly.
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
    proposalId: e.proposalId,
    runId: e.runId,
    detail: e.detail,
    createdAt: e.createdAt.toISOString(),
  }));
}

// Re-export for the observations lookup helper above.
export { agentGroundedObservations };

function emptyGates() {
  return {
    minScore: { passed: false, actualBps: 0, thresholdBps: 0 },
    recallCount: { passed: false, actual: 0, threshold: 0 },
    uniqueQueries: { passed: false, actual: 0, threshold: 0 },
    maxAgeDays: { passed: false, actual: 0, threshold: 0 },
    groundedEvidence: { passed: false, actual: 0, threshold: 1 as const },
  };
}
