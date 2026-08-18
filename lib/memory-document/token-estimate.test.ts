import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  estimateTokens,
  MEMORY_DETAILS_TOKEN_LIMIT,
  MEMORY_ENTRY_TOKEN_LIMIT,
  MEMORY_INDEX_TOKEN_LIMIT,
  MEMORY_READ_TOKEN_LIMIT,
} from "@/lib/memory-document/token-estimate";

describe("memory token estimator", () => {
  it("handles empty, rounding, and astral Unicode by code point", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("😀😀😀😀")).toBe(1);
    expect(estimateTokens("😀😀😀😀x")).toBe(2);
  });

  it.each([
    [MEMORY_INDEX_TOKEN_LIMIT, 1_000],
    [MEMORY_DETAILS_TOKEN_LIMIT, 4_000],
    [MEMORY_ENTRY_TOKEN_LIMIT, 1_200],
    [MEMORY_READ_TOKEN_LIMIT, 2_000],
  ])("is exact at the %i-token boundary", (limit, expected) => {
    expect(estimateTokens("x".repeat(limit * 4))).toBe(expected);
    expect(estimateTokens("x".repeat(limit * 4 + 1))).toBe(expected + 1);
  });
});
