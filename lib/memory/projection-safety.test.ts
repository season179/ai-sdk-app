import { describe, expect, it } from "vitest";

import { redactReadProjection } from "@/lib/memory/projection-safety";

describe("user profile projection fence", () => {
  it.each([
    ["user_profile", "<user_profile>private profile</user_profile>"],
    [
      "user_profile",
      '<user_profile trust="untrusted-read-projection" version="v1">private profile</user_profile>',
    ],
    ["user_profile", '<user_profile data-extra="x > y">private profile</user_profile>'],
    ["user_profile", '<user_profile version="v1">unterminated private profile'],
    [
      "profile_section",
      '<profile_section category="preferences_constraints" label="Preferences and constraints">private profile</profile_section>',
    ],
    [
      "profile_section",
      '<profile_section category="preferences_constraints" label="Preferences and constraints">unterminated private profile',
    ],
  ])("redacts complete, attributed, and unterminated %s variants", (marker, input) => {
    const result = redactReadProjection(`visible before\n${input}\nvisible after`);

    expect(result.contaminated).toBe(true);
    expect(result.markers).toContain(marker);
    expect(result.text).not.toContain("private profile");
    expect(result.text).toContain("visible before");
  });

  it.each([
    "<current_turn_metadata>copied</current_turn_metadata>",
    "<utc>copied</utc>",
    "<memory_context>copied</memory_context>",
    '<memory id="x">copied</memory>',
    "<available_skills>copied</available_skills>",
    '<skill_content name="x">copied</skill_content>',
    "<skill_references>copied</skill_references>",
    "<skill>copied</skill>",
    "<id>copied</id>",
    "<name>copied</name>",
    "<description>copied</description>",
    '<reference_content name="x">copied</reference_content>',
    '<reference id="x">copied</reference>',
  ])("fences every other emitted projection marker: %s", (input) => {
    expect(redactReadProjection(input).contaminated).toBe(true);
  });
});
