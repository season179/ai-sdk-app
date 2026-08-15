import { describe, expect, it, vi } from "vitest";

import {
  createMemoryTools,
  executeMemoryTool,
  memoryToolSpecs,
} from "@/lib/self-improvement/memory-tools";

describe("memory_search tool spec", () => {
  it("exposes exactly one direct-only tool contract requiring query", () => {
    expect(memoryToolSpecs).toHaveLength(1);
    expect(memoryToolSpecs[0].name).toBe("memory_search");
    expect(memoryToolSpecs[0].required).toEqual(["query"]);
    expect(memoryToolSpecs[0].description).toContain("<memory_context>");
    expect(memoryToolSpecs[0].description).toContain("typo-aware");
  });
});

describe("memory_search tool mapping", () => {
  it("forwards query, kind, and a bounded limit to ranked recall", async () => {
    const search = vi.fn(async () => [memoryItem()]);
    const result = await executeMemoryTool(
      "memory_search",
      {
        query: "  deployment telemetry  ",
        kind: "procedure",
        limit: 99,
      },
      { search },
    );
    expect(search).toHaveBeenCalledWith({
      agentId: "00000000-0000-0000-0000-000000000001",
      sessionId: undefined,
      query: "deployment telemetry",
      kind: "procedure",
      limit: 20,
    });
    expect(result).toMatchObject({
      success: true,
      count: 1,
      memories: [
        {
          id: "memory-id",
          versionId: "version-id",
          type: "procedural",
          kind: "procedure",
          content: "check telemetry",
          provenance: ["event-id"],
          score: 0.712346,
        },
      ],
    });
  });

  it("keeps session scope server-side and out of the model-visible schema", async () => {
    const search = vi.fn(async () => [memoryItem()]);
    await executeMemoryTool(
      "memory_search",
      { query: "session decision" },
      { search },
      {
        agentId: "00000000-0000-0000-0000-000000000002",
        sessionId: "00000000-0000-0000-0000-000000000003",
      },
    );
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "00000000-0000-0000-0000-000000000002",
        sessionId: "00000000-0000-0000-0000-000000000003",
      }),
    );
    expect(memoryToolSpecs[0].properties).not.toHaveProperty("sessionId");
    expect(createMemoryTools({ sessionId: "hidden" })).toHaveProperty("memory_search");
  });

  it("maps backend rejection to the fail-soft error", async () => {
    const result = (await executeMemoryTool(
      "memory_search",
      { query: "x" },
      {
        search: async () => {
          throw new Error("database unavailable");
        },
        logger: vi.fn(),
      },
    )) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("rejects empty query, invalid kind, and unknown tool without searching", async () => {
    const search = vi.fn(async () => [memoryItem()]);
    expect(await executeMemoryTool("memory_search", { query: "   " }, { search })).toMatchObject({
      success: false,
      error: "query is required.",
    });
    expect(
      await executeMemoryTool(
        "memory_search",
        { query: "x", kind: "bogus" },
        { search, logger: vi.fn() },
      ),
    ).toMatchObject({ success: false });
    expect(await executeMemoryTool("memory_insert", { query: "x" }, { search })).toMatchObject({
      success: false,
    });
    expect(search).not.toHaveBeenCalled();
  });
});

function memoryItem() {
  return {
    category: "memory" as const,
    id: "memory-id",
    versionId: "version-id",
    lineageId: "memory-id",
    type: "procedure" as const,
    memoryType: "procedural" as const,
    sourceKind: "curated",
    summary: "check telemetry",
    status: "approved" as const,
    eventDate: "2026-01-01T00:00:00.000Z",
    validDate: null,
    provenanceTraceIds: ["event-id"],
    authority: "reviewed",
    confidence: 90,
    contentKey: "check telemetry",
    score: {
      lexicalRank: 1,
      trigramRank: null,
      rrf: 0.01,
      normalizedRrf: 0.61,
      importance: 0.8,
      confidence: 0.9,
      freshness: 1,
      riskPenalty: 0,
      composite: 0.71234567,
    },
  };
}
