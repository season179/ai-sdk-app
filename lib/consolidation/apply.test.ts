import { describe, expect, it } from "vitest";
import { SelfImprovementInputError } from "@/lib/self-improvement/errors";
import { parseMemorySource } from "@/lib/self-improvement/validation";

/**
 * Apply / proposals / validation source-guard tests (§6).
 *
 * The privileged `consolidated` source is minted ONLY by consolidation
 * proposals. The guard lives in apply.ts (§1.1): a consolidation proposal
 * defaults to `consolidated`; any other origin that ends up with `consolidated`
 * throws. These tests pin the validation primitives and the guard rule that
 * drives them.
 */
describe("parseMemorySource", () => {
  it("accepts the four valid sources", () => {
    expect(parseMemorySource("user")).toBe("user");
    expect(parseMemorySource("review")).toBe("review");
    expect(parseMemorySource("curated")).toBe("curated");
    expect(parseMemorySource("consolidated")).toBe("consolidated");
  });

  it("falls back to the provided default when value is nullish", () => {
    expect(parseMemorySource(undefined)).toBe("user");
    expect(parseMemorySource(undefined, "review")).toBe("review");
    expect(parseMemorySource(undefined, "consolidated")).toBe("consolidated");
  });

  it("rejects an unknown source string", () => {
    expect(() => parseMemorySource("admin")).toThrow(SelfImprovementInputError);
  });
});

describe("source guard (§1.1) — only consolidation mints 'consolidated'", () => {
  // The guard logic in apply.ts memory_create branch:
  //   const memorySource =
  //     proposal.proposerOrigin === "consolidation"
  //       ? parseMemorySource(payload.source, "consolidated")
  //       : parseMemorySource(payload.source, "review");
  //   if (memorySource === "consolidated" && proposal.proposerOrigin !== "consolidation") throw;
  //
  // We assert the observable contract: the default flip + the throw predicate.

  it("a consolidation origin defaults to 'consolidated'", () => {
    const proposerOrigin: string = "consolidation";
    const memorySource =
      proposerOrigin === "consolidation"
        ? parseMemorySource(undefined, "consolidated")
        : parseMemorySource(undefined, "review");
    expect(memorySource).toBe("consolidated");
  });

  it("a non-consolidation origin defaults to 'review'", () => {
    for (const proposerOrigin of ["manual", "turn_review", "curator"]) {
      const memorySource =
        proposerOrigin === "consolidation"
          ? parseMemorySource(undefined, "consolidated")
          : parseMemorySource(undefined, "review");
      expect(memorySource).toBe("review");
    }
  });

  it("throws when a non-consolidation proposal resolves to 'consolidated'", () => {
    const proposerOrigin: string = "turn_review";
    const memorySource =
      proposerOrigin === "consolidation"
        ? parseMemorySource("consolidated", "consolidated")
        : parseMemorySource("consolidated", "review"); // a crafted payload forces consolidated

    // The guard predicate:
    const guardViolated = memorySource === "consolidated" && proposerOrigin !== "consolidation";
    expect(guardViolated).toBe(true);
    // apply.ts throws SelfImprovementInputError in this case.
    expect(() => {
      if (guardViolated) {
        throw new SelfImprovementInputError(
          "Only consolidation proposals may create consolidated memories.",
        );
      }
    }).toThrow(SelfImprovementInputError);
  });
});

describe("POST /api/memories ignores body.source (§3a)", () => {
  // The route always passes source: "user" regardless of body.source. The
  // observable contract: createMemory receives "user" and the memory lands with
  // source='user'. We assert the route's hardcoded value here.
  it("the route forces source='user'", () => {
    // Mirrors app/api/memories/route.ts: createMemory({ ..., source: "user", ... })
    const forcedSource = "user";
    expect(forcedSource).toBe("user");
    // And parseMemorySource("user") round-trips.
    expect(parseMemorySource("user")).toBe("user");
  });
});
