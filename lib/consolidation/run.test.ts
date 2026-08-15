import { describe, expect, it } from "vitest";

import { parseTstzRange } from "@/lib/consolidation/run";

describe("parseTstzRange", () => {
  it("normalizes PostgreSQL quoted timestamp bounds to ISO strings", () => {
    expect(parseTstzRange('["2026-01-01 00:00:00+00","2026-02-01 00:00:00+00")')).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    ]);
  });

  it("preserves unbounded bounds", () => {
    expect(parseTstzRange("[,2026-02-01T00:00:00.000Z)")).toEqual([
      null,
      "2026-02-01T00:00:00.000Z",
    ]);
  });
});
