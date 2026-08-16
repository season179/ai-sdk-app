export const DEFAULT_PROFILE_TOKEN_BUDGET = 1000;
export const MIN_PROFILE_TOKEN_BUDGET = 200;
export const MAX_PROFILE_TOKEN_BUDGET = 1500;
export const DEFAULT_PROFILE_MAX_CHARS = 4500;
export const MIN_PROFILE_MAX_CHARS = 1000;
export const MAX_PROFILE_MAX_CHARS = 5000;
export const DEFAULT_PROFILE_SYNTHESIS_CRON = "0 3 * * *";
export const DEFAULT_PROFILE_SYNTHESIS_TIMEZONE = "UTC";
export const DEFAULT_PROFILE_POLICY_VERSION = "profile-v1";

export type ProfileEnv = Readonly<Record<string, string | undefined>>;

function booleanEnv(env: ProfileEnv, name: string, fallback = false): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function clampedIntegerEnv(
  env: ProfileEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[name]?.trim();
  if (!value || !/^[+-]?\d+$/.test(value)) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function nonEmptyEnv(env: ProfileEnv, name: string, fallback: string): string {
  return env[name]?.trim() || fallback;
}

/** Read/injection is independent of self-improvement and governed writes. */
export function isProfileEnabled(env: ProfileEnv = process.env): boolean {
  return booleanEnv(env, "AGENT_PROFILE_ENABLED");
}

/** Master worker/write switch; automatic chat synthesis has an additional governed-write gate. */
export function isProfileSynthesisEnabled(env: ProfileEnv = process.env): boolean {
  return booleanEnv(env, "AGENT_PROFILE_SYNTHESIS_ENABLED");
}

/** Chat-derived and scheduled synthesis require governed observation writes. */
export function isAutomaticProfileSynthesisEnabled(env: ProfileEnv = process.env): boolean {
  return isProfileSynthesisEnabled(env) && booleanEnv(env, "AGENT_MEMORY_WRITE_ENABLED");
}

export function getProfileTokenBudget(env: ProfileEnv = process.env): number {
  return clampedIntegerEnv(
    env,
    "AGENT_PROFILE_TOKEN_BUDGET",
    DEFAULT_PROFILE_TOKEN_BUDGET,
    MIN_PROFILE_TOKEN_BUDGET,
    MAX_PROFILE_TOKEN_BUDGET,
  );
}

export function getProfileMaxChars(env: ProfileEnv = process.env): number {
  return clampedIntegerEnv(
    env,
    "AGENT_PROFILE_MAX_CHARS",
    DEFAULT_PROFILE_MAX_CHARS,
    MIN_PROFILE_MAX_CHARS,
    MAX_PROFILE_MAX_CHARS,
  );
}

export function getProfileSynthesisCron(env: ProfileEnv = process.env): string {
  const value = env.AGENT_PROFILE_SYNTHESIS_CRON;
  return value === undefined ? DEFAULT_PROFILE_SYNTHESIS_CRON : value.trim();
}

export function getProfileSynthesisTimezone(env: ProfileEnv = process.env): string {
  return nonEmptyEnv(env, "AGENT_PROFILE_SYNTHESIS_TIMEZONE", DEFAULT_PROFILE_SYNTHESIS_TIMEZONE);
}

export function getProfileSynthesisModel(env: ProfileEnv = process.env): string {
  return (
    env.AGENT_PROFILE_SYNTHESIS_MODEL?.trim() ||
    env.SELF_IMPROVEMENT_MODEL?.trim() ||
    env.OPENROUTER_DEFAULT_MODEL?.trim() ||
    ""
  );
}

export function getProfilePolicyVersion(env: ProfileEnv = process.env): string {
  return nonEmptyEnv(env, "AGENT_PROFILE_POLICY_VERSION", DEFAULT_PROFILE_POLICY_VERSION);
}

/** Explicit user-authority writes are intentionally independent of governed automatic writes. */
export function isProfileExplicitWriteEnabled(env: ProfileEnv = process.env): boolean {
  return booleanEnv(env, "AGENT_PROFILE_EXPLICIT_WRITE_ENABLED");
}

/** Deterministic conversation retrieval has its own kill switch. */
export function isConversationSearchEnabled(env: ProfileEnv = process.env): boolean {
  return booleanEnv(env, "CONVERSATION_SEARCH_ENABLED");
}
