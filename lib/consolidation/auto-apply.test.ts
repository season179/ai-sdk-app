import { describe, expect, it } from "vitest";

import { evaluateAutoApply } from "@/lib/consolidation/auto-apply";
import { isDuplicateClaimHashError } from "@/lib/self-improvement/apply";

/**
 * §4.4 auto-apply predicate + race-safety tests. The predicate is pure (given
 * its inputs), so we exhaustively assert every clause of "auto-apply iff ALL".
 * The duplicate_claim_hash detector is tested against realistic pg error shapes.
 */
const ALL_PASS = {
  globalEnabled: true,
  globalAutoApply: true,
  perAgentAutoApplyEnabled: true,
  admissionPolicy: "auto_apply_low_risk",
  kind: "memory_create",
  scoreBps: 9500,
  hasExistingClaimHash: false,
  isProtected: false,
};

describe("evaluateAutoApply — auto-apply iff ALL clauses pass (§4.4)", () => {
  it("is eligible when every clause holds", () => {
    expect(evaluateAutoApply(ALL_PASS)).toEqual({ eligible: true });
  });

  it("fails when the global master switch is off", () => {
    const d = evaluateAutoApply({ ...ALL_PASS, globalEnabled: false });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reasons).toContain("global_flag_off");
  });

  it("fails when the global auto-apply flag is off", () => {
    const d = evaluateAutoApply({ ...ALL_PASS, globalAutoApply: false });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reasons).toContain("auto_apply_flag_off");
  });

  it("fails when per-agent auto_apply_enabled is off", () => {
    const d = evaluateAutoApply({ ...ALL_PASS, perAgentAutoApplyEnabled: false });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reasons).toContain("per_agent_auto_apply_off");
  });

  it("fails when admission_policy is human_review", () => {
    const d = evaluateAutoApply({ ...ALL_PASS, admissionPolicy: "human_review" });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reasons).toContain("admission_policy_not_auto_apply");
  });

  it("fails when kind is not memory_create (never edit/archive)", () => {
    const d = evaluateAutoApply({ ...ALL_PASS, kind: "memory_edit" });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reasons).toContain("kind_not_memory_create");
  });

  it("fails when score_bps < 9000", () => {
    const d = evaluateAutoApply({ ...ALL_PASS, scoreBps: 8999 });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reasons).toContain("score_below_9000");
  });

  it("passes at exactly score_bps = 9000 (boundary)", () => {
    expect(evaluateAutoApply({ ...ALL_PASS, scoreBps: 9000 })).toEqual({ eligible: true });
  });

  it("fails when an existing memory has the same claim_hash", () => {
    const d = evaluateAutoApply({ ...ALL_PASS, hasExistingClaimHash: true });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reasons).toContain("existing_claim_hash");
  });

  it("fails when the target is protected", () => {
    const d = evaluateAutoApply({ ...ALL_PASS, isProtected: true });
    expect(d.eligible).toBe(false);
    if (!d.eligible) expect(d.reasons).toContain("target_protected");
  });

  it("collects multiple reasons when several clauses fail", () => {
    const d = evaluateAutoApply({
      ...ALL_PASS,
      globalAutoApply: false,
      scoreBps: 5000,
      kind: "memory_archive",
    });
    expect(d.eligible).toBe(false);
    if (!d.eligible) {
      expect(d.reasons).toEqual(
        expect.arrayContaining([
          "auto_apply_flag_off",
          "score_below_9000",
          "kind_not_memory_create",
        ]),
      );
    }
  });
});

describe("isDuplicateClaimHashError — race-safety detection (§4.4)", () => {
  it("detects a pg unique-violation on the claim_hash constraint", () => {
    const err = { code: "23505", constraint: "agent_memories_claim_hash_uniq" };
    expect(isDuplicateClaimHashError(err)).toBe(true);
  });

  it("detects a constraint name mentioning claim_hash", () => {
    const err = { code: "23505", constraint: "claim_hash_uniq" };
    expect(isDuplicateClaimHashError(err)).toBe(true);
  });

  it("detects the constraint in the message string (driver quirk)", () => {
    const err = { message: 'duplicate key value violates "agent_memories_claim_hash_uniq"' };
    expect(isDuplicateClaimHashError(err)).toBe(true);
  });

  it("does not match an unrelated unique violation", () => {
    const err = { code: "23505", constraint: "agent_skills_skill_name_uniq" };
    expect(isDuplicateClaimHashError(err)).toBe(false);
  });

  it("does not match a non-23505 error", () => {
    const err = { code: "23503", constraint: "agent_memories_claim_hash_uniq" };
    expect(isDuplicateClaimHashError(err)).toBe(false);
  });

  it("does not match null / non-object", () => {
    expect(isDuplicateClaimHashError(null)).toBe(false);
    expect(isDuplicateClaimHashError("oops")).toBe(false);
    expect(isDuplicateClaimHashError(undefined)).toBe(false);
  });
});
