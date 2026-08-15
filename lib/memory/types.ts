import type { MemoryKind, MemoryType } from "@/db/schema";

export type RecallRequest = {
  agentId: string;
  sessionId?: string;
  query: string;
  asOf: Date;
  kind?: MemoryKind;
  includeDecisions?: boolean;
  decisionLimit?: number;
  generalLimit?: number;
  maxItems?: number;
  maxChars?: number;
  /** Server-only cancellation/deadline; never model-visible. */
  signal?: AbortSignal;
  deadlineAt?: number;
};

export type RecallScoreComponents = {
  lexicalRank: number | null;
  trigramRank: number | null;
  rrf: number;
  normalizedRrf: number;
  importance: number;
  confidence: number;
  freshness: number;
  riskPenalty: number;
  composite: number;
};

export type DecisionRecallItem = {
  category: "decision";
  id: string;
  lineageId: string;
  type: "decision";
  sourceKind: "decision";
  summary: string;
  status: "open" | "succeeded" | "failed" | "mixed" | "unknown";
  subjectKey: string;
  rationale: string;
  outcome: {
    id: string;
    summary: string;
    assessment: "supports" | "contradicts" | "inconclusive";
    occurredAt: string;
  } | null;
  eventDate: string;
  validDate: string | null;
  provenanceTraceIds: string[];
  authority: string;
  confidence: number;
  score: RecallScoreComponents;
};

export type GeneralRecallItem = {
  category: "memory";
  id: string;
  versionId: string;
  lineageId: string;
  type: MemoryKind;
  memoryType: MemoryType;
  sourceKind: string;
  summary: string;
  status: "approved";
  eventDate: string;
  validDate: string | null;
  provenanceTraceIds: string[];
  authority: string;
  confidence: number;
  contentKey: string;
  score: RecallScoreComponents;
};

export type RecallItem = DecisionRecallItem | GeneralRecallItem;

export type RecallDebug = {
  candidateIds: string[];
  injectedIds: string[];
  rejected: Array<{ id: string; reason: string }>;
  scores: Record<string, RecallScoreComponents>;
};

export type RecallStatus = "hit" | "miss" | "skipped" | "degraded";

export type RecallResult = {
  items: RecallItem[];
  renderedBlock: string;
  status: RecallStatus;
  elapsedMs: number;
  debug: RecallDebug;
};

export type RecallRepositoryResult = {
  decisions: DecisionRecallItem[];
  general: GeneralRecallItem[];
  candidateIds: string[];
};

export interface RecallRepository {
  recall(request: RecallRequest): Promise<RecallRepositoryResult>;
}
