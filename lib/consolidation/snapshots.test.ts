import { describe, expect, it } from "vitest";

import { renderMemoryBlock } from "@/lib/consolidation/snapshots";

/**
 * Snapshot tests (§6): the in-session block is frozen across POSTs and refreshes
 * on a new session. The DB-backed freeze is integration territory; here we pin
 * the pure renderMemoryBlock so the frozen block's shape is stable.
 */
describe("renderMemoryBlock", () => {
  it("renders a <declarative_memory> block for non-empty input", () => {
    const block = renderMemoryBlock([
      { kind: "preference", content: "prefers dark mode", confidence: 90 },
    ]);
    expect(block).toContain("<declarative_memory>");
    expect(block).toContain('kind="preference"');
    expect(block).toContain('confidence="90"');
    expect(block).toContain("prefers dark mode");
  });

  it("returns an empty string for empty input", () => {
    expect(renderMemoryBlock([])).toBe("");
  });

  it("escapes XML-special characters in content", () => {
    const block = renderMemoryBlock([
      { kind: "fact", content: 'a < b & c > d "e"', confidence: 100 },
    ]);
    expect(block).not.toContain("< b");
    expect(block).toContain("&lt;");
    expect(block).toContain("&amp;");
    expect(block).toContain("&gt;");
    expect(block).toContain("&quot;");
  });

  it("is deterministic across calls (the freeze is a pure render)", () => {
    const memories = [
      { kind: "preference", content: "x", confidence: 1 },
      { kind: "fact", content: "y", confidence: 2 },
    ];
    expect(renderMemoryBlock(memories)).toEqual(renderMemoryBlock(memories));
  });
});
