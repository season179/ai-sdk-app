import { describe, expect, it } from "vitest";

import { claimHash, conceptTags, contentHash, normalizeClaim } from "@/lib/consolidation/normalize";

describe("normalizeClaim", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeClaim("I Prefer Dark-Mode!")).toBe("i prefer dark mode");
  });

  it("collapses whitespace", () => {
    expect(normalizeClaim("  multiple   spaces  ")).toBe("multiple spaces");
  });

  it("is deterministic (same text → same output)", () => {
    expect(normalizeClaim("Hello, World!")).toBe(normalizeClaim("hello world"));
  });

  it("caps at 2000 chars", () => {
    const long = "a ".repeat(1500);
    expect(normalizeClaim(long).length).toBeLessThanOrEqual(2000);
  });
});

describe("claimHash", () => {
  it("is stable for equivalent text", () => {
    expect(claimHash("Dark Mode!")).toBe(claimHash("dark mode"));
  });

  it("differs for different text", () => {
    expect(claimHash("dark mode")).not.toBe(claimHash("light mode"));
  });

  it("returns a 64-char hex sha256", () => {
    expect(claimHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("conceptTags", () => {
  it("extracts alpha runs ≥ 4 chars, excluding stop words", () => {
    const tags = conceptTags("The user prefers dark theme and Python");
    expect(tags).toContain("prefers");
    expect(tags).toContain("dark");
    expect(tags).toContain("theme");
    expect(tags).toContain("python");
    expect(tags).not.toContain("the");
  });

  it("dedupes", () => {
    const tags = conceptTags("python python python");
    expect(tags).toEqual(["python"]);
  });

  it("respects the max cap", () => {
    const tags = conceptTags(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
      4,
    );
    expect(tags.length).toBeLessThanOrEqual(4);
  });
});

describe("contentHash", () => {
  it("hashes raw (unnormalized) content", () => {
    expect(contentHash("Dark Mode")).not.toBe(contentHash("dark mode"));
    expect(contentHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
