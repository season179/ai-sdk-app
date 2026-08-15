import { and, eq, isNull } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import { type AdmissionMetadataV1, agentMemories } from "@/db/schema";
import {
  AUTO_APPLY_MIN_SCORE_BPS,
  isMemoryConsolidationAutoApply,
  isMemoryConsolidationEnabled,
} from "@/lib/consolidation/config";
import { recordMemoryEvent } from "@/lib/consolidation/events";
import { applyReviewProposal, isDuplicateClaimHashError } from "@/lib/self-improvement/apply";
import type { ReviewProposal } from "@/lib/self-improvement/proposals";

/**
 * The auto-apply predicate + execution (§4.4). Auto-apply iff ALL hold:
 *   - global flag on (MEMORY_CONSOLIDATION_AUTO_APPLY) AND
 *   - master switch on (MEMORY_CONSOLIDATION_ENABLED) AND
 *   - per-agent auto_apply_enabled AND
 *   - admission_policy = 'auto_apply_low_risk' AND
 *   - kind = 'memory_create' (never edit/archive) AND
 *   - score_bps ≥ 9000 AND
 *   - no existing memory with the same claim_hash AND
 *   - the target is not is_protected.
 *
 * Anything failing any clause routes to human_review. Auto-apply is additive-
 * only: it never mutates or removes, and every apply is logged.
 *
 * Race safety: the "no existing claim_hash" check is NOT trusted in app code
 * alone. Auto-apply still goes through applyReviewProposal(id) (advisory lock)
 * and relies on the agent_memories_claim_hash_uniq index. A duplicate-key on
 * insert is caught and treated as already-applied / no-op, then writes an
 * agent_memory_events row with detail.reason = "duplicate_claim_hash" (see
 * apply.ts). This keeps auto-apply additive-only.
 */

export type AutoApplyInput = {
  agentId: string;
  proposalId: string;
  claimHash: string | undefined;
  scoreBps: number | undefined;
  kind: string;
  /** Per-agent auto_apply_enabled from the settings row. */
  perAgentAutoApplyEnabled: boolean;
};

export type AutoApplyDecision = { eligible: true } | { eligible: false; reasons: string[] };

/**
 * Evaluate the auto-apply predicate for a consolidation proposal. Pure (given
 * the per-agent flag + existing-memory check inputs); the DB read for the
 * claim_hash precheck is done by the caller via hasExistingClaimHash, so the
 * predicate itself is unit-testable.
 */
export function evaluateAutoApply(input: {
  globalEnabled: boolean;
  globalAutoApply: boolean;
  perAgentAutoApplyEnabled: boolean;
  admissionPolicy: string;
  kind: string;
  scoreBps: number;
  hasExistingClaimHash: boolean;
  isProtected: boolean;
}): AutoApplyDecision {
  const reasons: string[] = [];

  if (!input.globalEnabled) reasons.push("global_flag_off");
  if (!input.globalAutoApply) reasons.push("auto_apply_flag_off");
  if (!input.perAgentAutoApplyEnabled) reasons.push("per_agent_auto_apply_off");
  if (input.admissionPolicy !== "auto_apply_low_risk")
    reasons.push("admission_policy_not_auto_apply");
  if (input.kind !== "memory_create") reasons.push("kind_not_memory_create");
  if (input.scoreBps < AUTO_APPLY_MIN_SCORE_BPS) reasons.push("score_below_9000");
  if (input.hasExistingClaimHash) reasons.push("existing_claim_hash");
  if (input.isProtected) reasons.push("target_protected");

  return reasons.length === 0 ? { eligible: true } : { eligible: false, reasons };
}

/** Does an approved, non-deleted memory with this claim_hash already exist? */
export async function hasExistingClaimHash(
  agentId: string,
  claimHash: string | undefined,
  db: AppDbClient = getDb(),
): Promise<boolean> {
  if (!claimHash) return false;
  const rows = await db
    .select({ id: agentMemories.id })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.claimHash, claimHash),
        eq(agentMemories.status, "approved"),
        isNull(agentMemories.revokedAt),
        eq(agentMemories.tombstoned, false),
        eq(agentMemories.injectionBlocked, false),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Attempt auto-apply for a consolidation proposal. Returns whether the proposal
 * was auto-applied (true), routed to human review (false, with reasons recorded
 * on the proposal's admission_metadata.autoApply), or treated as a no-op due to
 * a duplicate claim_hash race (false, reason duplicate_claim_hash logged).
 *
 * The proposal must already be admitted with admission_policy='auto_apply_low_risk'
 * for the predicate to pass; otherwise this is a no-op that leaves it for human
 * review.
 */
export async function maybeAutoApplyConsolidation(
  input: {
    agentId: string;
    proposal: ReviewProposal;
    perAgentAutoApplyEnabled: boolean;
  },
  db: AppDbClient = getDb(),
): Promise<{ applied: boolean; reason?: string }> {
  const meta = input.proposal.admissionMetadata ?? undefined;
  if (input.proposal.sourceCandidateId) {
    return { applied: false, reason: "typed_candidate_requires_human_review" };
  }
  const claimHash = meta?.version === 1 ? meta.claimHash : undefined;

  const [globalEnabled, globalAutoApply, existingClaim] = await Promise.all([
    isMemoryConsolidationEnabled(),
    isMemoryConsolidationAutoApply(),
    hasExistingClaimHash(input.agentId, claimHash, db),
  ]);

  const decision = evaluateAutoApply({
    globalEnabled,
    globalAutoApply,
    perAgentAutoApplyEnabled: input.perAgentAutoApplyEnabled,
    admissionPolicy: input.proposal.admissionPolicy,
    kind: input.proposal.kind,
    scoreBps: meta?.scoreBps ?? 0,
    hasExistingClaimHash: existingClaim,
    // The target memory does not exist yet (this is a memory_create), so it
    // cannot be protected. is_protected guards the edit/archive path, which
    // auto-apply never takes (kind must be memory_create).
    isProtected: false,
  });

  if (!decision.eligible) {
    // Route to human review. The reasons are already on admission_metadata via
    // the run; nothing to apply.
    return { applied: false, reason: decision.reasons.join(",") };
  }

  try {
    await applyReviewProposal(input.proposal.id);
    return { applied: true };
  } catch (error) {
    if (isDuplicateClaimHashError(error)) {
      // Already-applied / no-op: a concurrent writer won the claim_hash race.
      // Log the duplicate_claim_hash event (§4.4) and treat as success-ish no-op.
      await recordMemoryEvent({
        agentId: input.agentId,
        eventType: "applied",
        origin: "consolidation",
        summary: `Auto-apply no-op: duplicate claim_hash for proposal ${input.proposal.id}.`,
        proposalId: input.proposal.id,
        detail: {
          version: 1,
          admissionMetadata: meta ?? undefined,
          reason: "duplicate_claim_hash",
        },
      });
      return { applied: false, reason: "duplicate_claim_hash" };
    }
    throw error;
  }
}

/**
 * Detect a duplicate claim_hash race. Re-exported from apply.ts (the canonical
 * detection used by both the manual and auto-apply paths).
 */
export { isDuplicateClaimHashError };

/** Stamp the autoApply eligibility onto an AdmissionMetadata (for the UI). */
export function stampAutoApply(
  meta: AdmissionMetadataV1,
  decision: AutoApplyDecision,
): AdmissionMetadataV1 {
  return {
    ...meta,
    autoApply: {
      eligible: decision.eligible,
      reasons: "reasons" in decision ? decision.reasons : [],
    },
  };
}
