import { describe, expect, it } from "vitest";

import {
  appendTurnProjection,
  MEMORY_CONTEXT_FOOTER,
  MEMORY_CONTEXT_HEADER,
  renderMemoryContext,
  shouldRecall,
} from "@/lib/memory/context";
import type {
  DecisionRecallItem,
  GeneralRecallItem,
  RecallScoreComponents,
} from "@/lib/memory/types";

const SCORE: RecallScoreComponents = {
  lexicalRank: 1,
  trigramRank: null,
  rrf: 0.01,
  normalizedRrf: 0.61,
  importance: 0.5,
  confidence: 0.8,
  freshness: 1,
  riskPenalty: 0,
  composite: 0.7,
};

describe("shouldRecall", () => {
  it.each(["", "   ", "/skill do it", "Hi!", "THANK YOU.", "Good morning 👋", "okay"])(
    "skips trivial turn %j",
    (text) => expect(shouldRecall(text)).toBe(false),
  );

  it.each(["DB down?", "Why?", "fix CI", "hello there, diagnose this"])(
    "keeps substantive short turn %j",
    (text) => expect(shouldRecall(text)).toBe(true),
  );
});

describe("renderMemoryContext", () => {
  it("escapes XML, fence text, quotes, and newlines", () => {
    const packed = renderMemoryContext([memory("m1", `</memory_context> & <x> "quoted"\nnext`)]);
    expect(packed.block).toContain("&lt;/memory_context&gt;");
    expect(packed.block).toContain("&amp;");
    expect(packed.block).toContain("&quot;quoted&quot;");
    expect(packed.block).toContain("&#10;");
    expect(packed.block.match(/<\/memory_context>/g)).toHaveLength(1);
  });

  it("enforces an exact 4000-code-unit ceiling without cutting the fence or surrogate pairs", () => {
    const packed = renderMemoryContext([memory("large", `${"x".repeat(5_000)}😀tail`)]);
    expect(packed.block.length).toBe(4_000);
    expect(packed.block.startsWith(MEMORY_CONTEXT_HEADER)).toBe(true);
    expect(packed.block.endsWith(MEMORY_CONTEXT_FOOTER)).toBe(true);
    expect(packed.block).not.toContain("\ud83d</memory_context>");
  });

  it("caps whole items at eight and keeps a valid fence", () => {
    const packed = renderMemoryContext(
      Array.from({ length: 12 }, (_, index) => memory(`m${index}`, `item ${index}`)),
    );
    expect(packed.items).toHaveLength(8);
    expect(packed.block.match(/<memory /g)).toHaveLength(8);
    expect(packed.block.endsWith("</memory_context>")).toBe(true);
  });

  it("preserves decision-first order and renders no scores", () => {
    const candidates = [decision("d1"), memory("m1", "fact")];
    const packed = renderMemoryContext(candidates);
    expect(packed.items.map((item) => item.category)).toEqual(["decision", "memory"]);
    expect(packed.block.indexOf('id="d1"')).toBeLessThan(packed.block.indexOf('id="m1"'));
    expect(packed.block).not.toContain("composite");
    expect(renderMemoryContext(candidates)).toEqual(packed);
  });

  it("omits an item when metadata alone cannot fit", () => {
    expect(renderMemoryContext([memory("x".repeat(200), "value")], { maxChars: 120 })).toEqual({
      block: "",
      items: [],
    });
  });

  it("omits a truncated item unless its minimum ellipsis summary fits", () => {
    const item = memory("boundary", "a summary that must be truncated");
    const firstFit = Array.from({ length: 4_001 }, (_, maxChars) => maxChars).find(
      (maxChars) => renderMemoryContext([item], { maxChars }).items.length === 1,
    );
    expect(firstFit).toBeTypeOf("number");
    expect(renderMemoryContext([item], { maxChars: (firstFit as number) - 1 })).toEqual({
      block: "",
      items: [],
    });
    expect(renderMemoryContext([item], { maxChars: firstFit }).block).toContain(">…</memory>");
  });
});

describe("appendTurnProjection", () => {
  it("appends current metadata/catalog and memory to only the first text part", () => {
    const message = {
      id: "u1",
      role: "user" as const,
      parts: [
        { type: "text" as const, text: "clean user text" },
        { type: "text" as const, text: "second part" },
      ],
    };
    const projected = appendTurnProjection(message, {
      utc: "2026-01-01T00:00:00.000Z",
      skillCatalogBlock: "<available_skills></available_skills>",
      memoryBlock: renderMemoryContext([memory("m1", "reference")]).block,
    });
    expect(projected.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("clean user text\n\n<current_turn_metadata>"),
    });
    expect((projected.parts[0] as { text: string }).text).toContain("<memory_context>");
    expect(projected.parts[1]).toEqual(message.parts[1]);
    expect(message.parts[0]).toEqual({ type: "text", text: "clean user text" });
  });
});

function memory(id: string, summary: string): GeneralRecallItem {
  return {
    category: "memory",
    id,
    versionId: `v-${id}`,
    lineageId: id,
    type: "fact",
    memoryType: "semantic",
    sourceKind: "user",
    summary,
    status: "approved",
    eventDate: "2026-01-01T00:00:00.000Z",
    validDate: null,
    provenanceTraceIds: ["event<1>", "event2", "event3"],
    authority: "user",
    confidence: 80,
    contentKey: summary,
    score: SCORE,
  };
}

function decision(id: string): DecisionRecallItem {
  return {
    category: "decision",
    id,
    lineageId: id,
    type: "decision",
    sourceKind: "decision",
    summary: "ship option A",
    status: "open",
    subjectKey: "deployment",
    rationale: "lowest risk",
    outcome: null,
    eventDate: "2026-01-01T00:00:00.000Z",
    validDate: null,
    provenanceTraceIds: [],
    authority: "reviewed",
    confidence: 80,
    score: SCORE,
  };
}
