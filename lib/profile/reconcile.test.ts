import { describe, expect, it } from "vitest";

import { normalizeStableFactKey, reconcileProfile } from "@/lib/profile/reconcile";
import type { ProfileFactV1, ProfileSynthesisSnapshot } from "@/lib/profile/types";

const fact: ProfileFactV1 = {
  factKey: "editor",
  sentence: "The user prefers Vim.",
  category: "preferences_constraints",
  authority: "synthesized",
  protected: false,
  order: 0,
};

function snapshot(overrides: Partial<ProfileSynthesisSnapshot> = {}): ProfileSynthesisSnapshot {
  return {
    agentId: "00000000-0000-0000-0000-000000000010",
    expectedVersionId: "00000000-0000-0000-0000-000000000011",
    expectedVersionNo: 1,
    expectedDirtyGeneration: 2,
    synthesizedGeneration: 1,
    lowerBounds: {
      observation: { createdAt: null, id: null },
      memoryVersion: { createdAt: null, id: null },
    },
    upperBounds: {
      observation: {
        createdAt: "2026-01-02T00:00:00.000000Z",
        id: "00000000-0000-0000-0000-000000000012",
      },
      memoryVersion: { createdAt: null, id: null },
    },
    currentVersion: {
      id: "00000000-0000-0000-0000-000000000011",
      agentId: "00000000-0000-0000-0000-000000000010",
      versionNo: 1,
      body: fact.sentence,
      facts: [fact],
      trigger: "scheduled",
      authority: "synthesized",
      charCount: fact.sentence.length,
      tokenCount: 6,
      modelId: "fake",
      promptHash: "hash",
      schemaVersion: 1,
      policyVersion: "profile-v1",
      createdAt: new Date("2026-01-01"),
      supersedesProfileVersionId: null,
    },
    currentSources: [
      {
        factKey: fact.factKey,
        sourceRole: "primary",
        traceEventId: "00000000-0000-0000-0000-000000000013",
        memoryVersionId: null,
        live: true,
        occurredAt: new Date("2026-01-01"),
      },
    ],
    observationDeltas: [
      {
        id: "00000000-0000-0000-0000-000000000012",
        traceEventId: "00000000-0000-0000-0000-000000000014",
        sessionId: "00000000-0000-0000-0000-000000000015",
        content: "I prefer Emacs now.",
        createdAt: new Date("2026-01-02"),
      },
    ],
    memoryVersionDeltas: [],
    activeMemories: [],
    tombstones: [],
    ...overrides,
  };
}

describe("profile reconciliation", () => {
  it("normalizes stable keys deterministically", () => {
    expect(normalizeStableFactKey("  Café / Keyboard  ")).toBe("café-keyboard");
    expect(normalizeStableFactKey("***")).toMatch(/^fact-[0-9a-f]{12}$/);
  });

  it("lets the newest direct statement update a synthesized fact", () => {
    const result = reconcileProfile(snapshot(), {
      operations: [
        {
          operation: "update",
          targetFactKey: "editor",
          sentence: "The user prefers Emacs.",
          category: "preferences_constraints",
          observationIds: ["00000000-0000-0000-0000-000000000012"],
          memoryVersionIds: [],
        },
      ],
    });
    expect(result.facts[0].sentence).toBe("The user prefers Emacs.");
    expect(result.sources[0].traceEventId).toBe("00000000-0000-0000-0000-000000000014");
  });

  it("preserves user/protected facts against implicit update and invalidation", () => {
    const protectedFact = { ...fact, authority: "user" as const, protected: true };
    const base = snapshot();
    if (!base.currentVersion) throw new Error("Test snapshot needs a current version.");
    const result = reconcileProfile(
      snapshot({ currentVersion: { ...base.currentVersion, facts: [protectedFact] } }),
      {
        operations: [
          {
            operation: "invalidate",
            targetFactKey: "editor",
            observationIds: ["00000000-0000-0000-0000-000000000012"],
            memoryVersionIds: [],
          },
        ],
      },
    );
    expect(result.facts).toEqual([{ ...protectedFact, order: 0 }]);
  });

  it("drops synthesized facts whose only source is deleted or archived", () => {
    const result = reconcileProfile(
      snapshot({ currentSources: [{ ...snapshot().currentSources[0], live: false }] }),
      { operations: [] },
    );
    expect(result.facts).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it("keeps an independently supported fact but recopies only live sources", () => {
    const live = snapshot().currentSources[0];
    const result = reconcileProfile(
      snapshot({
        currentSources: [
          { ...live, live: false },
          {
            ...live,
            traceEventId: null,
            memoryVersionId: "00000000-0000-0000-0000-000000000016",
            live: true,
          },
        ],
      }),
      { operations: [] },
    );
    expect(result.facts).toHaveLength(1);
    expect(result.sources).toEqual([
      expect.objectContaining({ memoryVersionId: "00000000-0000-0000-0000-000000000016" }),
    ]);
  });

  it("applies active tombstones after model output", () => {
    const result = reconcileProfile(
      snapshot({ tombstones: [{ factKey: "editor", deletedAt: new Date(), reason: null }] }),
      {
        operations: [
          {
            operation: "update",
            targetFactKey: "editor",
            sentence: "The user prefers Emacs.",
            category: "preferences_constraints",
            observationIds: ["00000000-0000-0000-0000-000000000012"],
            memoryVersionIds: [],
          },
        ],
      },
    );
    expect(result.facts).toEqual([]);
  });
});
