export const MEMORY_DOCUMENT_KEY_PATTERN = /^mem_[0-9a-f]{32}$/u;

export type MemoryDocumentDetail = {
  timestamp: string;
  text: string;
};

export type MemoryDocumentEntry = {
  key: string;
  updatedAt: string;
  summary: string;
  details: MemoryDocumentDetail[];
};

export type MemoryDocument = {
  agentId: string;
  version: number;
  indexBody: string;
  details: MemoryDocumentEntry[];
  indexTokenCount: number;
  detailsTokenCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ModelMemoryEntry = {
  key: string | null;
  summary: string;
  details: string[];
};

export type MemoryClarificationCandidate = {
  key: string;
  summary: string;
};

export type MemoryRewriteOutput =
  | {
      status: "needs_clarification";
      clarificationQuestion: string;
      clarificationCandidates: MemoryClarificationCandidate[];
    }
  | { status: "no_op"; entries: ModelMemoryEntry[] }
  | { status: "applied"; entries: ModelMemoryEntry[] };

export type MemoryWriteSource = "tool" | "manual_ui";

export type MemoryWriteMetadata = {
  entryCount: number;
  indexTokenCount: number;
  detailsTokenCount: number;
  affectedKeys: string[];
  newKeys: string[];
  droppedKeys: string[];
  changedSummaries: Array<{ key: string; summary: string }>;
};

export type MemoryWriteResult =
  | ({
      status: "applied";
      durable: true;
      version: number;
    } & MemoryWriteMetadata)
  | ({
      status: "no_op";
      durable: false;
      version: number;
    } & MemoryWriteMetadata)
  | {
      status: "needs_clarification";
      durable: false;
      version: number;
      clarificationQuestion: string;
      clarificationCandidates: MemoryClarificationCandidate[];
    }
  | {
      status: "conflict" | "memory_needs_review" | "unavailable" | "invalid_output";
      durable: false;
      version: number;
      error: string;
    };
