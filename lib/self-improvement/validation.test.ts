import { describe, expect, it } from "vitest";

import { parseMemoryContent } from "@/lib/self-improvement/validation";

describe("generic memory content validation", () => {
  it.each([
    '<profile_section category="preferences_constraints" label="Preferences and constraints">The user likes pizza.</profile_section>',
    '<profile_section category="preferences_constraints" label="Preferences and constraints">The user likes pizza.',
  ])("rejects standalone profile projection control markup: %s", (content) => {
    expect(() => parseMemoryContent(content)).toThrow("read projection");
  });
});
