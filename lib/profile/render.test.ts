import { describe, expect, it } from "vitest";

import { PROFILE_RENDER_PROMPT_HASH, sortForSurvival } from "@/lib/profile/render";
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

  it("has a deterministic prompt hash", () => {
    expect(PROFILE_RENDER_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
