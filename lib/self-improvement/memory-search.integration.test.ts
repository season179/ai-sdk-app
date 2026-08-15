import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { closePool, getPool } from "@/lib/scheduler/db";
import { createMemory, searchMemories } from "@/lib/self-improvement/memories";

/**
 * memory_search behavioral tests (§10.5): returns only approved/non-deleted
 * rows, respects kind/limit, ranks by relevance. Opt-in integration tests —
 * skipped without CONSOLIDATION_INTEGRATION=1 + DATABASE_URL.
 */
const DATABASE_AVAILABLE =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";

const describeIntegration = DATABASE_AVAILABLE ? describe : describe.skip;

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

describeIntegration("searchMemories behavioral (integration)", () => {
  beforeAll(() => getPool());
  afterAll(async () => {
    await closePool();
  });

  it("returns only approved, non-deleted rows matching the query", async () => {
    const marker = `searchtest-approved-${Date.now()}`;
    await createMemory({
      agentId: AGENT_ID,
      kind: "fact",
      content: `${marker} visible fact`,
      source: "user",
      confidence: 80,
    });
    const results = await searchMemories(AGENT_ID, marker);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((m) => m.status === "approved")).toBe(true);
    expect(results.some((m) => m.content.includes(marker))).toBe(true);
  });

  it("respects the kind filter", async () => {
    const marker = `searchtest-kind-${Date.now()}`;
    await createMemory({
      agentId: AGENT_ID,
      kind: "preference",
      content: `${marker} kind preference`,
      source: "user",
    });
    const prefs = await searchMemories(AGENT_ID, marker, { kind: "preference" });
    expect(prefs.every((m) => m.kind === "preference")).toBe(true);

    const facts = await searchMemories(AGENT_ID, marker, { kind: "fact" });
    expect(facts.every((m) => m.kind === "fact")).toBe(true);
  });

  it("respects the limit", async () => {
    const results = await searchMemories(AGENT_ID, "the", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("ranks exact FTS matches ahead of trigram-only typo matches", async () => {
    const marker = `lexicalrank${Date.now()}`;
    await createMemory({
      agentId: AGENT_ID,
      kind: "fact",
      content: `${marker} exact searchable phrase`,
      source: "user",
      confidence: 10,
    });
    await createMemory({
      agentId: AGENT_ID,
      kind: "fact",
      content: `${marker.slice(0, -1)}x fuzzy alternative`,
      source: "user",
      confidence: 90,
    });
    const results = await searchMemories(AGENT_ID, marker);
    expect(results[0]?.content).toContain("exact searchable phrase");
  });

  it("treats LIKE metacharacters in the query as literal", async () => {
    // A query containing % or _ must not match everything.
    const results = await searchMemories(AGENT_ID, "%_this_should_not_match_anything_xyz");
    expect(results.length).toBe(0);
  });
});

/** Reference getDb so the import isn't tree-shaken in non-integration runs. */
void getDb;
