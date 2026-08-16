import { describe, expect, it } from "vitest";

import { redactReadProjection } from "@/lib/memory/projection-safety";

describe("user profile projection fence", () => {
  it.each([
    "<user_profile>private profile</user_profile>",
    '<user_profile trust="untrusted-read-projection" version="v1">private profile</user_profile>',
    '<user_profile data-extra="x > y">private profile</user_profile>',
    '<user_profile version="v1">unterminated private profile',
  ])("redacts complete, attributed, and unterminated variants", (input) => {
    const result = redactReadProjection(`visible before\n${input}\nvisible after`);

    expect(result.contaminated).toBe(true);
    expect(result.markers).toContain("user_profile");
    expect(result.text).not.toContain("private profile");
    expect(result.text).toContain("visible before");
  });
});
