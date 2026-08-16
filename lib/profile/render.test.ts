import { describe, expect, it } from "vitest";

import {
  PROFILE_RENDER_PROMPT_HASH,
  ProfileMandatoryFactsOverBudgetError,
  selectFactsForRenderBudget,
  sortForSurvival,
} from "@/lib/profile/render";
import type { ProfileFactV1 } from "@/lib/profile/types";

function fact(overrides: Partial<ProfileFactV1>): ProfileFactV1 {
  return {
    factKey: "fact",
    sentence: "The user has a durable preference.",
    category: "preferences_constraints",
    authority: "synthesized",
    protected: false,
    order: 0,
    ...overrides,
  };
}

describe("profile render policy", () => {
  it("uses the fixed survival order", () => {
    const sorted = sortForSurvival([
      fact({ factKey: "recent", category: "interaction_instructions", order: 4 }),
      fact({ factKey: "identity", category: "identity_context", order: 3 }),
      fact({ factKey: "safety", sentence: "The user has a dietary safety constraint.", order: 2 }),
      fact({ factKey: "protected", protected: true, order: 1 }),
      fact({
        factKey: "explicit",
        category: "interaction_instructions",
        authority: "user",
        order: 0,
      }),
    ]);
    expect(sorted.map((row) => row.factKey)).toEqual([
      "explicit",
      "protected",
      "safety",
      "identity",
      "recent",
    ]);
  });

  it("prunes optional facts but never user/protected facts beyond the render budget", () => {
    const mandatory = fact({
      factKey: "mandatory",
      authority: "user",
      sentence: "The user requires captions.",
    });
    const selected = selectFactsForRenderBudget(
      [mandatory, fact({ factKey: "optional", sentence: `${"A".repeat(300)}.` })],
      100,
      100,
    );
    expect(selected.map((row) => row.factKey)).toEqual(["mandatory"]);
    expect(() =>
      selectFactsForRenderBudget([{ ...mandatory, sentence: `${"界".repeat(300)}。` }], 500, 50),
    ).toThrow(ProfileMandatoryFactsOverBudgetError);
  });

  it("has a deterministic prompt hash", () => {
    expect(PROFILE_RENDER_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
