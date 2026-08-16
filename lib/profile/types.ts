export type ProfileFactCategory =
  | "identity_context"
  | "preferences_constraints"
  | "active_projects_goals"
  | "interaction_instructions";

export type ProfileFactAuthority = "synthesized" | "user";
export type ProfileVersionTrigger = "scheduled" | "explicit" | "manual_ui";
export type ProfileVersionAuthority = "synthesized" | "user";
export type ProfileSourceRole = "primary" | "corroborating" | "context";

export type ProfileFactV1 = {
  factKey: string;
  sentence: string;
  category: ProfileFactCategory;
  authority: ProfileFactAuthority;
  protected: boolean;
  order: number;
};

export type ProfileSourceHandle = {
  factKey: string;
  sourceRole: ProfileSourceRole;
  traceEventId: string | null;
  memoryVersionId: string | null;
};

export type ProfileSourceState = ProfileSourceHandle & {
  live: boolean;
  occurredAt: Date | null;
};

export type ProfileTuple = {
  /** Exact PostgreSQL timestamptz text; preserves microseconds across tuple watermarks. */
  createdAt: string | null;
  id: string | null;
};

export type ProfileWatermarks = {
  observation: ProfileTuple;
  memoryVersion: ProfileTuple;
};

export type ProfileObservationInput = {
  id: string;
  traceEventId: string;
  sessionId: string | null;
  content: string;
  createdAt: Date;
};

export type ProfileMemoryInput = {
  memoryId: string;
  memoryVersionId: string;
  content: string;
  source: "user" | "review" | "curated" | "consolidated";
  authority: "user" | "tool" | "reviewed" | "consolidated" | "legacy_import";
  protected: boolean;
  active: boolean;
  createdAt: Date;
  expiresAt: Date | null;
};

export type ProfileTombstone = {
  factKey: string;
  deletedAt: Date;
  reason: string | null;
};

export type ProfileVersion = {
  id: string;
  agentId: string;
  versionNo: number;
  body: string;
  facts: ProfileFactV1[];
  trigger: ProfileVersionTrigger;
  authority: ProfileVersionAuthority;
  charCount: number;
  tokenCount: number;
  modelId: string | null;
  promptHash: string;
  schemaVersion: number;
  policyVersion: string;
  createdAt: Date;
  supersedesProfileVersionId: string | null;
};

export type CurrentProfile = ProfileVersion & {
  dirtyGeneration: number;
  synthesizedGeneration: number;
  lastSynthesisAttemptAt: Date | null;
  lastSynthesizedAt: Date | null;
  lastSynthesisError: string | null;
};

export type ProfileSynthesisSnapshot = {
  agentId: string;
  expectedVersionId: string | null;
  expectedVersionNo: number;
  expectedDirtyGeneration: number;
  synthesizedGeneration: number;
  lowerBounds: ProfileWatermarks;
  upperBounds: ProfileWatermarks;
  currentVersion: ProfileVersion | null;
  currentSources: ProfileSourceState[];
  observationDeltas: ProfileObservationInput[];
  memoryVersionDeltas: ProfileMemoryInput[];
  activeMemories: ProfileMemoryInput[];
  tombstones: ProfileTombstone[];
};

export type ProfileExtractionOperation = {
  operation: "add" | "update" | "invalidate";
  targetFactKey?: string;
  sentence?: string;
  category?: ProfileFactCategory;
  observationIds: string[];
  memoryVersionIds: string[];
};

export type ProfileExtractionOutput = {
  operations: ProfileExtractionOperation[];
};

export type ReconciledProfile = {
  facts: ProfileFactV1[];
  sources: ProfileSourceHandle[];
};

export type SynthesisTrigger = ProfileVersionTrigger;

export type ProfileSynthesisResult =
  | { result: "created"; profileVersionId: string; versionNo: number }
  | { result: "noop"; profileVersionId: null; versionNo: null };

export type ProfileSynthesisModel = {
  modelId: string;
  extract(snapshot: ProfileSynthesisSnapshot): Promise<ProfileExtractionOutput>;
  render(input: {
    facts: ProfileFactV1[];
    previousBody: string;
    maxChars: number;
    tokenBudget: number;
  }): Promise<string>;
  repair(input: {
    body: string;
    facts: ProfileFactV1[];
    issues: string[];
    maxChars: number;
    tokenBudget: number;
  }): Promise<string>;
};
