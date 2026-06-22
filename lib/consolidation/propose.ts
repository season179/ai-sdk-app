import type { AppDbClient } from "@/db";
import type { AdmissionMetadata, AdmissionPolicy } from "@/db/schema";
import {
  AUTO_APPLY_MIN_SCORE_BPS,
  isMemoryConsolidationAutoApply,
} from "@/lib/consolidation/config";
import { recordMemoryEvent } from "@/lib/consolidation/events";
import { createReviewProposal, type ReviewProposal } from "@/lib/self-improvement/proposals";

/**
 * Turn a passed candidate into an agent_review_proposal (§2 propose.ts). Writes
 * a normal proposal row with proposerOrigin='consolidation'. Approval — manual
 * or auto — flows through the existing applyReviewProposal(id) (advisory lock),
 * so consolidation reuses the same concurrency-safe choke point. On apply, the
 * memory lands with source='consolidated' (§3d, §1.1 source guard).
 *
 * Admission policy (§4.4): 'auto_apply_low_risk' when the candidate clears the
 * score bar (≥ 9000 bps) AND the global auto-apply flag is on — this makes the
 * proposal eligible for maybeAutoApplyConsolidation. Everything else is
 * 'human_review'. The full predicate (per-agent flag, existing claim_hash, etc.)
 * is re-checked at apply time, so the policy here is only the admission lane.
 */
export async function proposeCandidate(
  input: {
    agentId: string;
    claimKey: string;
    snippet: string;
    metadata: AdmissionMetadata;
    runId: string;
    candidateId?: string;
  },
  db: AppDbClient,
): Promise<ReviewProposal> {
  // Infer a memory kind from the concept tags when possible; default to 'fact'.
  // The human can edit at approval time.
  const kind = inferKind(input.metadata);
  const admissionPolicy = pickAdmissionPolicy(input.metadata.scoreBps);

  const proposal = await createReviewProposal(
    {
      kind: "memory_create",
      payload: {
        memoryKind: kind,
        content: input.snippet,
        source: "consolidated",
        confidence: 100, // consolidation proposals start at full confidence
      },
      rationale: `Consolidated from ${input.metadata.groundedObservationIds?.length ?? 0} grounded observation(s). Score ${input.metadata.scoreBps ?? 0} bps.`,
      proposerOrigin: "consolidation",
      admissionPolicy,
      admissionMetadata: input.metadata,
      agentId: input.agentId,
    },
    db,
  );

  // Fire a `proposed` timeline event. Fail-soft.
  await recordMemoryEvent({
    agentId: input.agentId,
    eventType: "proposed",
    origin: "consolidation",
    summary: `Proposed consolidated ${kind} (score ${input.metadata.scoreBps ?? 0} bps, ${admissionPolicy}).`,
    proposalId: proposal.id,
    runId: input.runId,
    detail: { version: 1, admissionMetadata: input.metadata },
  });

  return proposal;
}

/**
 * Admission lane for a candidate. 'auto_apply_low_risk' only when the score bar
 * (§4.4: ≥ 9000) is cleared AND the global auto-apply flag is on — otherwise the
 * proposal would land in the auto lane but never auto-apply, which is noise.
 */
function pickAdmissionPolicy(scoreBps: number | undefined): AdmissionPolicy {
  const score = scoreBps ?? 0;
  if (score >= AUTO_APPLY_MIN_SCORE_BPS && isMemoryConsolidationAutoApply()) {
    return "auto_apply_low_risk";
  }
  return "human_review";
}

/** Cheap kind inference from concept tags — never authoritative. */
function inferKind(metadata: AdmissionMetadata): "preference" | "fact" | "correction" | "persona" {
  // The candidate metadata doesn't carry concept tags directly; the caller can
  // extend this later. Default to 'fact' — the safest general bucket.
  void metadata;
  return "fact";
}
