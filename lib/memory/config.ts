export const MEMORY_WRITE_POLICY_DEFAULT = "write-v1";
export const MEMORY_EXTRACTOR_ID = "turn-review-v1";
export const MEMORY_CANDIDATE_SCHEMA_VERSION = 1;
export const TRACE_PAYLOAD_MAX_BYTES = 65_536;
export const TRACE_ARTIFACT_MAX_BYTES = 262_144;
export const TRACE_ARTIFACT_EXCERPT_MAX_CHARS = 4_000;

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function isMemoryWriteEnabled(): boolean {
  return booleanEnv("AGENT_MEMORY_WRITE_ENABLED", false);
}

/** Deterministic conversation retrieval keeps its existing independent switch. */
export function isConversationSearchEnabled(): boolean {
  return booleanEnv("CONVERSATION_SEARCH_ENABLED", false);
}

export function getMemoryPolicyVersion(): string {
  return process.env.AGENT_MEMORY_POLICY_VERSION?.trim() || MEMORY_WRITE_POLICY_DEFAULT;
}

export function getTraceRetentionDays(): number {
  return integerEnv("AGENT_MEMORY_TRACE_RETENTION_DAYS", 30, 1, 3650);
}

export function getGateMinScoreBps(): number {
  return integerEnv("AGENT_MEMORY_GATE_MIN_SCORE_BPS", 6500, 0, 10_000);
}
