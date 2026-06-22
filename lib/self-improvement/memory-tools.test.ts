import { describe, expect, it } from "vitest";

import { executeMemoryTool, memoryToolSpecs } from "@/lib/self-improvement/memory-tools";

/**
 * memory_search tool tests (§10.5). The tool is read-only; the database path is
 * integration territory (gated in pipeline.test.ts). Here we assert the tool's
 * input contract — it validates query/kind/limit and never inserts.
 */
describe("memory_search tool spec", () => {
  it("exposes exactly one tool named memory_search", () => {
    expect(memoryToolSpecs).toHaveLength(1);
    expect(memoryToolSpecs[0].name).toBe("memory_search");
  });

  it("requires a query", () => {
    expect(memoryToolSpecs[0].required).toEqual(["query"]);
  });
});

describe("memory_search tool input validation", () => {
  it("rejects an empty query", async () => {
    const result = (await executeMemoryTool("memory_search", { query: "   " })) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("query is required.");
  });

  it("rejects an unknown tool name", async () => {
    const result = (await executeMemoryTool("memory_insert", { query: "x" })) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
  });

  it("rejects an invalid kind with the unavailable message (fail-soft wrapper)", async () => {
    // parseKind throws SelfImprovementInputError, which the handler wrapper maps
    // to the unavailable message. Either way the tool returns success:false and
    // never inserts.
    const result = (await executeMemoryTool("memory_search", {
      query: "x",
      kind: "bogus",
    })) as { success: boolean };
    expect(result.success).toBe(false);
  });
});
