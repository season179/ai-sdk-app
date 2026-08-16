import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_MAX_CHARS,
  DEFAULT_PROFILE_POLICY_VERSION,
  DEFAULT_PROFILE_SYNTHESIS_CRON,
  DEFAULT_PROFILE_SYNTHESIS_TIMEZONE,
  DEFAULT_PROFILE_TOKEN_BUDGET,
  getProfileMaxChars,
  getProfilePolicyVersion,
  getProfileSynthesisCron,
  getProfileSynthesisModel,
  getProfileSynthesisTimezone,
  getProfileTokenBudget,
  isAutomaticProfileSynthesisEnabled,
  isConversationSearchEnabled,
  isProfileEnabled,
  isProfileExplicitWriteEnabled,
  isProfileSynthesisEnabled,
  type ProfileEnv,
} from "@/lib/profile/config";

const env = (values: Record<string, string | undefined> = {}): ProfileEnv => values;

describe("profile configuration", () => {
  it("uses safe defaults", () => {
    const empty = env();

    expect(isProfileEnabled(empty)).toBe(false);
    expect(isProfileSynthesisEnabled(empty)).toBe(false);
    expect(isAutomaticProfileSynthesisEnabled(empty)).toBe(false);
    expect(isProfileExplicitWriteEnabled(empty)).toBe(false);
    expect(isConversationSearchEnabled(empty)).toBe(false);
    expect(getProfileTokenBudget(empty)).toBe(DEFAULT_PROFILE_TOKEN_BUDGET);
    expect(getProfileMaxChars(empty)).toBe(DEFAULT_PROFILE_MAX_CHARS);
    expect(getProfileSynthesisCron(empty)).toBe(DEFAULT_PROFILE_SYNTHESIS_CRON);
    expect(getProfileSynthesisTimezone(empty)).toBe(DEFAULT_PROFILE_SYNTHESIS_TIMEZONE);
    expect(getProfileSynthesisModel(empty)).toBe("");
    expect(getProfilePolicyVersion(empty)).toBe(DEFAULT_PROFILE_POLICY_VERSION);
  });

  it("strictly parses booleans and ignores invalid truthy-looking values", () => {
    expect(isProfileEnabled(env({ AGENT_PROFILE_ENABLED: " TRUE " }))).toBe(true);
    expect(isProfileEnabled(env({ AGENT_PROFILE_ENABLED: "1" }))).toBe(false);
    expect(
      isProfileExplicitWriteEnabled(env({ AGENT_PROFILE_EXPLICIT_WRITE_ENABLED: "yes" })),
    ).toBe(false);
    expect(isConversationSearchEnabled(env({ CONVERSATION_SEARCH_ENABLED: "false" }))).toBe(false);
  });

  it("accepts integers and clamps numeric values to portable limits", () => {
    expect(getProfileTokenBudget(env({ AGENT_PROFILE_TOKEN_BUDGET: "800" }))).toBe(800);
    expect(getProfileTokenBudget(env({ AGENT_PROFILE_TOKEN_BUDGET: "199" }))).toBe(200);
    expect(getProfileTokenBudget(env({ AGENT_PROFILE_TOKEN_BUDGET: "1501" }))).toBe(1500);
    expect(getProfileMaxChars(env({ AGENT_PROFILE_MAX_CHARS: "3200" }))).toBe(3200);
    expect(getProfileMaxChars(env({ AGENT_PROFILE_MAX_CHARS: "999" }))).toBe(1000);
    expect(getProfileMaxChars(env({ AGENT_PROFILE_MAX_CHARS: "9000" }))).toBe(5000);
    expect(getProfileMaxChars(env({ AGENT_PROFILE_MAX_CHARS: "5000" }))).toBe(5000);
  });

  it("falls back for malformed, fractional, empty, and unsafe integers", () => {
    for (const value of ["", "12px", "3.5", "Infinity", "9007199254740992"]) {
      expect(getProfileTokenBudget(env({ AGENT_PROFILE_TOKEN_BUDGET: value }))).toBe(
        DEFAULT_PROFILE_TOKEN_BUDGET,
      );
      expect(getProfileMaxChars(env({ AGENT_PROFILE_MAX_CHARS: value }))).toBe(
        DEFAULT_PROFILE_MAX_CHARS,
      );
    }
  });

  it("uses the profile, self-improvement, then OpenRouter model fallback chain", () => {
    const models = {
      AGENT_PROFILE_SYNTHESIS_MODEL: " profile/model ",
      SELF_IMPROVEMENT_MODEL: "review/model",
      OPENROUTER_DEFAULT_MODEL: "default/model",
    };
    expect(getProfileSynthesisModel(env(models))).toBe("profile/model");
    expect(getProfileSynthesisModel(env({ ...models, AGENT_PROFILE_SYNTHESIS_MODEL: "  " }))).toBe(
      "review/model",
    );
    expect(
      getProfileSynthesisModel(
        env({ ...models, AGENT_PROFILE_SYNTHESIS_MODEL: "", SELF_IMPROVEMENT_MODEL: "" }),
      ),
    ).toBe("default/model");
  });

  it("requires governed writes only for automatic synthesis", () => {
    const synthesis = { AGENT_PROFILE_SYNTHESIS_ENABLED: "true" };
    expect(isProfileSynthesisEnabled(env(synthesis))).toBe(true);
    expect(isAutomaticProfileSynthesisEnabled(env(synthesis))).toBe(false);
    expect(
      isAutomaticProfileSynthesisEnabled(env({ ...synthesis, AGENT_MEMORY_WRITE_ENABLED: "true" })),
    ).toBe(true);
    expect(
      isAutomaticProfileSynthesisEnabled(
        env({ AGENT_PROFILE_SYNTHESIS_ENABLED: "false", AGENT_MEMORY_WRITE_ENABLED: "true" }),
      ),
    ).toBe(false);

    const independent = env({
      SELF_IMPROVEMENT_ENABLED: "false",
      AGENT_MEMORY_WRITE_ENABLED: "false",
      AGENT_PROFILE_ENABLED: "true",
      AGENT_PROFILE_EXPLICIT_WRITE_ENABLED: "true",
      CONVERSATION_SEARCH_ENABLED: "true",
    });
    expect(isProfileEnabled(independent)).toBe(true);
    expect(isProfileExplicitWriteEnabled(independent)).toBe(true);
    expect(isConversationSearchEnabled(independent)).toBe(true);
  });

  it("trims text settings and falls back when they are empty", () => {
    expect(getProfileSynthesisCron(env({ AGENT_PROFILE_SYNTHESIS_CRON: " 0 4 * * * " }))).toBe(
      "0 4 * * *",
    );
    expect(getProfileSynthesisCron(env({ AGENT_PROFILE_SYNTHESIS_CRON: " " }))).toBe("");
    expect(
      getProfileSynthesisTimezone(env({ AGENT_PROFILE_SYNTHESIS_TIMEZONE: " Asia/Tokyo " })),
    ).toBe("Asia/Tokyo");
    expect(getProfilePolicyVersion(env({ AGENT_PROFILE_POLICY_VERSION: " profile-v2 " }))).toBe(
      "profile-v2",
    );
    expect(getProfileSynthesisTimezone(env({ AGENT_PROFILE_SYNTHESIS_TIMEZONE: " " }))).toBe(
      DEFAULT_PROFILE_SYNTHESIS_TIMEZONE,
    );
    expect(getProfilePolicyVersion(env({ AGENT_PROFILE_POLICY_VERSION: " " }))).toBe(
      DEFAULT_PROFILE_POLICY_VERSION,
    );
  });
});
