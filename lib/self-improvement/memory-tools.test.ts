import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createConversationSearchTools,
  createMemoryTools,
  executeMemoryTool,
  memoryToolSpecs,
} from "@/lib/self-improvement/memory-tools";

const AGENT_ID = "00000000-0000-0000-0000-000000000009";
const KEY = "mem_00000000000000000000000000000001";

describe("memory tool contracts", () => {
  it("exposes intent-only memory_write and 1..5-key memory_read schemas", () => {
    const write = memoryToolSpecs.find((spec) => spec.name === "memory_write");
    expect(write).toMatchObject({
      required: ["intent"],
      properties: { intent: { type: "string" } },
    });
    expect(Object.keys(write?.properties ?? {})).toEqual(["intent"]);

    const read = memoryToolSpecs.find((spec) => spec.name === "memory_read");
    expect(read).toMatchObject({
      required: ["keys"],
      properties: {
        keys: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: { pattern: "^mem_[0-9a-f]{32}$" },
        },
      },
    });
    expect(read?.properties).not.toHaveProperty("agentId");
    expect(write?.properties).not.toHaveProperty("modelId");
  });

  it("keeps document read/write always on with all flags disabled", () => {
    vi.stubEnv("MEMORY_SEARCH_ENABLED", "false");
    vi.stubEnv("CONVERSATION_SEARCH_ENABLED", "false");
    const tools = createMemoryTools({});
    expect(tools).toHaveProperty("memory_read");
    expect(tools).toHaveProperty("memory_write");
    expect(tools).not.toHaveProperty("memory_search");
    expect(tools).not.toHaveProperty("conversation_time_search");
    expect(createConversationSearchTools({})).toEqual({});
    vi.unstubAllEnvs();
  });
});

describe("memory document tool execution", () => {
  it("passes server-owned scope, resolved model, API key, and abort signal to memory_write", async () => {
    const write = vi.fn(async () => ({
      status: "no_op" as const,
      durable: false as const,
      version: 2,
      entryCount: 1,
      indexTokenCount: 20,
      detailsTokenCount: 30,
      affectedKeys: [],
      newKeys: [],
      droppedKeys: [],
      changedSummaries: [],
    }));
    const abort = new AbortController();
    const result = await executeMemoryTool(
      "memory_write",
      { intent: "remember that I prefer tea", agentId: "model-controlled" },
      { write },
      {
        agentId: AGENT_ID,
        sessionId: "00000000-0000-0000-0000-000000000010",
        messageId: "msg-1",
        modelId: "anthropic/resolved",
        apiKey: "server-key",
        abortSignal: abort.signal,
      },
    );
    expect(result).toMatchObject({ success: true, status: "no_op", version: 2 });
    expect(write).toHaveBeenCalledWith("remember that I prefer tea", {
      agentId: AGENT_ID,
      sessionId: "00000000-0000-0000-0000-000000000010",
      messageId: "msg-1",
      modelId: "anthropic/resolved",
      apiKey: "server-key",
      abortSignal: abort.signal,
    });
  });

  it("returns memory_read results and keeps agent scope server-owned", async () => {
    const read = vi.fn(async () => ({
      status: "ok" as const,
      content: "complete entry",
      returnedKeys: [KEY],
      missingKeys: [],
      omittedKeys: [],
      degradedKeys: [],
      estimatedTokens: 4,
      version: 3,
    }));
    const result = await executeMemoryTool(
      "memory_read",
      { keys: [KEY], agentId: "model-controlled" },
      { read },
      { agentId: AGENT_ID },
    );
    expect(result).toMatchObject({ success: true, content: "complete entry", version: 3 });
    expect(read).toHaveBeenCalledWith({ agentId: AGENT_ID, keys: [KEY] });
  });

  it("maps bounded write failures without exposing model or database errors", async () => {
    const write = vi.fn(async () => ({
      status: "unavailable" as const,
      durable: false as const,
      version: 1,
      error: "Memory update is temporarily unavailable.",
    }));
    const result = await executeMemoryTool(
      "memory_write",
      { intent: "remember tea" },
      { write },
      { modelId: "resolved", apiKey: "key" },
    );
    expect(result).toEqual({
      success: false,
      status: "unavailable",
      durable: false,
      version: 1,
      error: "Memory update is temporarily unavailable.",
    });
  });
});

describe("unchanged passive memory tools", () => {
  it("forwards bounded passive search with server scope", async () => {
    const search = vi.fn(async () => [memoryItem()]);
    const result = await executeMemoryTool(
      "memory_search",
      { query: " telemetry ", kind: "procedure", limit: 99 },
      { search },
      { agentId: AGENT_ID },
    );
    expect(search).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      sessionId: undefined,
      query: "telemetry",
      kind: "procedure",
      limit: 20,
    });
    expect(result).toMatchObject({ success: true, count: 1 });
  });

  it("keeps conversation time search independently gated", () => {
    vi.stubEnv("CONVERSATION_SEARCH_ENABLED", "true");
    expect(createConversationSearchTools({})).toHaveProperty("conversation_time_search");
    vi.unstubAllEnvs();
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
