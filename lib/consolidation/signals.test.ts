import { describe, expect, it } from "vitest";

import type { AgentGroundedObservation } from "@/db/schema";
import { groupByClaim } from "@/lib/consolidation/signals";

/**
 * Regression tests for the recall-signal derivation (covers the C1/C2/C3 fix).
 *
 * The pre-fix bugs:
 *  - C1: uniqueQueryCount was frozen at 1 (the onConflict merge never touched
 *    it), so the unique_query_count ≥ 3 gate was structurally unsatisfiable.
 *  - C2: recallCount doubled on every sweep (the merge added excluded.recall_count
 *    while runConsolidation re-scanned the FULL observation set).
 *  - C3: queryHashes/recallDays were never derived from distinct sessions/days.
 *
 * groupByClaim now derives ALL fields from the complete observation bucket, so
 * a claim seen across multiple sessions/days gets the diversity signal it needs.
 * These tests pin that derivation as a pure function (no DB).
 */

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function obs(
  overrides: Partial<AgentGroundedObservation> & Pick<AgentGroundedObservation, "content">,
): AgentGroundedObservation {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    agentId: overrides.agentId ?? AGENT_ID,
    sessionId: overrides.sessionId ?? null,
    originKind: overrides.originKind ?? "chat_user",
    sourceMessageId: overrides.sourceMessageId ?? null,
    sourceMemoryId: overrides.sourceMemoryId ?? null,
    content: overrides.content,
    contentHash: overrides.contentHash ?? "h",
    createdAt: overrides.createdAt ?? new Date("2026-06-22T00:00:00.000Z"),
    deletedAt: overrides.deletedAt ?? null,
  } as AgentGroundedObservation;
}

describe("groupByClaim — derives the diversity signal from the bucket", () => {
  it("rolls identical claims into one bucket keyed by claim_hash", () => {
    const buckets = groupByClaim([
      obs({ id: "o1", sessionId: "s1", sourceMessageId: "m1", content: "I prefer dark mode" }),
      obs({ id: "o2", sessionId: "s2", sourceMessageId: "m2", content: "I prefer dark mode" }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].observationIds).toEqual(["o1", "o2"]);
  });

  it("separates different claims into different buckets", () => {
    const buckets = groupByClaim([
      obs({ id: "o1", sessionId: "s1", sourceMessageId: "m1", content: "I prefer dark mode" }),
      obs({ id: "o2", sessionId: "s1", sourceMessageId: "m2", content: "I prefer light mode" }),
    ]);
    expect(buckets).toHaveLength(2);
  });

  it("uniqueQueryCount = distinct source sessions (chat) / source memories (memory_user)", () => {
    // Same claim across 3 sessions → uniqueQueryCount = 3 (the gate threshold).
    const buckets = groupByClaim([
      obs({ id: "o1", sessionId: "s1", sourceMessageId: "m1", content: "I prefer dark mode" }),
      obs({ id: "o2", sessionId: "s2", sourceMessageId: "m2", content: "I prefer dark mode" }),
      obs({ id: "o3", sessionId: "s3", sourceMessageId: "m3", content: "I prefer dark mode" }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].uniqueQueryCount).toBe(3);
    expect(buckets[0].queryHashes).toHaveLength(3);
    expect(buckets[0].queryHashes).toEqual(expect.arrayContaining(["s1", "s2", "s3"]));
  });

  it("uniqueQueryCount collapses repeated observations within the SAME session", () => {
    // Two observations in one session is one "query" — cross-session diversity
    // is what counts, not repeated statements within a session.
    const buckets = groupByClaim([
      obs({ id: "o1", sessionId: "s1", sourceMessageId: "m1", content: "I prefer dark mode" }),
      obs({ id: "o2", sessionId: "s1", sourceMessageId: "m2", content: "I prefer dark mode" }),
    ]);
    expect(buckets[0].uniqueQueryCount).toBe(1);
  });

  it("memory_user observations derive queryHash from source_memory_id", () => {
    const buckets = groupByClaim([
      obs({
        id: "o1",
        originKind: "memory_user",
        sessionId: null,
        sourceMessageId: null,
        sourceMemoryId: "00000000-0000-0000-0000-0000000000aa",
        content: "I prefer dark mode",
      }),
      obs({
        id: "o2",
        originKind: "memory_user",
        sessionId: null,
        sourceMessageId: null,
        sourceMemoryId: "00000000-0000-0000-0000-0000000000bb",
        content: "I prefer dark mode",
      }),
    ]);
    expect(buckets[0].uniqueQueryCount).toBe(2);
  });

  it("recallDays = distinct UTC days (diversity component)", () => {
    const buckets = groupByClaim([
      obs({
        id: "o1",
        sessionId: "s1",
        sourceMessageId: "m1",
        content: "I prefer dark mode",
        createdAt: new Date("2026-06-20T10:00:00.000Z"),
      }),
      obs({
        id: "o2",
        sessionId: "s2",
        sourceMessageId: "m2",
        content: "I prefer dark mode",
        createdAt: new Date("2026-06-22T22:00:00.000Z"),
      }),
    ]);
    expect(buckets[0].recallDays).toEqual(["2026-06-20", "2026-06-22"]);
  });

  it("recallCount = number of backing observations (not doubled on rescan)", () => {
    // C2 regression: the upsert used to ADD excluded.recall_count, so a full
    // rescan of N observations grew recallCount by N each sweep. groupByClaim
    // now returns exactly observationIds.length as the bucket's count.
    const buckets = groupByClaim([
      obs({ id: "o1", sessionId: "s1", sourceMessageId: "m1", content: "I prefer dark mode" }),
      obs({ id: "o2", sessionId: "s2", sourceMessageId: "m2", content: "I prefer dark mode" }),
      obs({ id: "o3", sessionId: "s3", sourceMessageId: "m3", content: "I prefer dark mode" }),
      obs({ id: "o4", sessionId: "s3", sourceMessageId: "m4", content: "I prefer dark mode" }),
    ]);
    expect(buckets[0].observationIds).toHaveLength(4);
    // recallCount is derived as observationIds.length by upsertRecallSignal.
  });

  it("does not dedupe repeated user statements across turns (each is evidence)", () => {
    // §1.2: dedupe is by source identity, NEVER by content. Two distinct
    // messages survive as separate observation ids.
    const buckets = groupByClaim([
      obs({ id: "o1", sessionId: "s1", sourceMessageId: "m1", content: "I like Python." }),
      obs({ id: "o2", sessionId: "s1", sourceMessageId: "m2", content: "I like Python." }),
    ]);
    expect(buckets[0].observationIds).toEqual(["o1", "o2"]);
  });

  it("derivation is idempotent — the same input bucket yields the same signal", () => {
    const input = [
      obs({ id: "o1", sessionId: "s1", sourceMessageId: "m1", content: "I prefer dark mode" }),
      obs({ id: "o2", sessionId: "s2", sourceMessageId: "m2", content: "I prefer dark mode" }),
    ];
    expect(groupByClaim(input)).toEqual(groupByClaim(input));
  });
});
