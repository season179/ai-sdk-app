import { describe, expect, it, vi } from "vitest";

import {
  createConversationSearchTools,
  createMemoryTools,
  executeMemoryTool,
  memoryToolSpecs,
} from "@/lib/self-improvement/memory-tools";

describe("memory tool specs", () => {
  it("keeps lexical and temporal search as separate direct-only contracts", () => {
    expect(memoryToolSpecs).toHaveLength(2);
    expect(memoryToolSpecs[0].name).toBe("memory_search");
    expect(memoryToolSpecs[0].required).toEqual(["query"]);
    expect(memoryToolSpecs[0].description).toContain("<memory_context>");
    expect(memoryToolSpecs[0].description).toContain("typo-aware");

    const temporal = memoryToolSpecs[1];
    expect(temporal.name).toBe("conversation_time_search");
    expect(temporal.required).toEqual(["from", "to"]);
    expect(temporal.properties).toEqual(
      expect.objectContaining({
        from: expect.objectContaining({ type: "string" }),
        to: expect.objectContaining({ type: "string" }),
        order: expect.objectContaining({ enum: ["asc", "desc"] }),
        role: expect.objectContaining({ enum: ["user", "assistant", "system"] }),
        limit: expect.objectContaining({ minimum: 1, maximum: 20 }),
        cursor: expect.objectContaining({ type: "string" }),
      }),
    );
    expect(temporal.properties).not.toHaveProperty("agentId");
    expect(temporal.properties).not.toHaveProperty("sessionId");
    expect(temporal.properties).not.toHaveProperty("query");
  });

  it("gates temporal exposure independently", () => {
    vi.stubEnv("CONVERSATION_SEARCH_ENABLED", "false");
    expect(createConversationSearchTools({})).not.toHaveProperty("conversation_time_search");
    expect(createMemoryTools({})).not.toHaveProperty("conversation_time_search");

    vi.stubEnv("CONVERSATION_SEARCH_ENABLED", "true");
    expect(createConversationSearchTools({})).toHaveProperty("conversation_time_search");
    expect(createMemoryTools({})).toHaveProperty("conversation_time_search");
    vi.unstubAllEnvs();
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

  it("forwards exact temporal parameters with agent scope closed over", async () => {
    const conversationSearch = vi.fn(async () => ({ results: [], nextCursor: null }));
    const input = {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      order: "asc",
      role: "user",
      limit: 7,
      cursor: "opaque",
    };
    expect(
      await executeMemoryTool(
        "conversation_time_search",
        input,
        { conversationSearch },
        { agentId: "00000000-0000-0000-0000-000000000009", sessionId: "hidden" },
      ),
    ).toEqual({ results: [], nextCursor: null });
    expect(conversationSearch).toHaveBeenCalledWith(input, {
      agentId: "00000000-0000-0000-0000-000000000009",
    });
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
