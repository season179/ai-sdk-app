import type { AgentTraceEvent, CandidateGateStatus, MemoryType } from "@/db/schema";
import { getGateMinScoreBps } from "@/lib/memory/config";
import { detectPromptInjection, detectSecret } from "@/lib/memory/redaction";

export const GATE_WEIGHTS_BPS = {
  confidence: 3500,
  evidence: 2500,
  durability: 2000,
  intent: 2000,
} as const;

export type GateCandidate = {
  memoryType: MemoryType;
  content: string;
  evidenceTraceEventIds: string[];
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  proposedOperation: "ADD" | "UPDATE" | "INVALIDATE" | "NOOP" | "REVIEW";
};

export type GateOptions = {
  allWindowEvents: AgentTraceEvent[];
  citedEvents: AgentTraceEvent[];
  minScoreBps?: number;
  exactDuplicate?: boolean;
  contradiction?: boolean;
  sensitivityPenaltyBps?: number;
  now?: Date;
};

export type GateResult = {
  status: CandidateGateStatus;
  reason: string;
  scoreBps: number;
};

function reject(reason: string, status: CandidateGateStatus = "rejected"): GateResult {
  return { status, reason, scoreBps: 0 };
}

export function gateMemoryCandidate(candidate: GateCandidate, options: GateOptions): GateResult {
  if (candidate.evidenceTraceEventIds.length === 0) return reject("no_evidence");
  if (options.citedEvents.length !== new Set(candidate.evidenceTraceEventIds).size) {
    return reject("unknown_or_outside_window_evidence");
  }

  const latestTerminals = new Map<string, AgentTraceEvent>();
  for (const row of options.allWindowEvents) {
    if (row.eventType !== "task_terminal_state") continue;
    const current = latestTerminals.get(row.traceId);
    if (!current || row.sequenceNo >= current.sequenceNo) latestTerminals.set(row.traceId, row);
  }
  const citedTraceIds = new Set(options.citedEvents.map((row) => row.traceId));
  if (
    [...citedTraceIds].some(
      (traceId) => latestTerminals.get(traceId)?.terminalStatus !== "completed",
    )
  ) {
    return reject("trace_not_completed");
  }
  if (detectSecret(candidate.content)) return reject("secret_or_credential", "quarantined");
  if (detectPromptInjection(candidate.content)) {
    return reject("prompt_injection_or_permission_rewrite", "quarantined");
  }
  if (candidate.validFrom && Number.isNaN(Date.parse(candidate.validFrom))) {
    return reject("malformed_validity_interval");
  }
  if (candidate.validTo && Number.isNaN(Date.parse(candidate.validTo))) {
    return reject("malformed_validity_interval");
  }
  if (
    candidate.validFrom &&
    candidate.validTo &&
    Date.parse(candidate.validFrom) >= Date.parse(candidate.validTo)
  ) {
    return reject("reversed_validity_interval");
  }
  if (candidate.proposedOperation === "NOOP") return reject("extractor_noop");

  const support = options.citedEvents.filter((row) =>
    ["user_message", "explicit_memory_write", "tool_result", "task_terminal_state"].includes(
      row.eventType,
    ),
  );
  const userSupport = support.some((row) =>
    ["user_message", "explicit_memory_write"].includes(row.eventType),
  );
  const toolSupport = support.some((row) => row.eventType === "tool_result");
  const terminalSupport = support.some(
    (row) => row.eventType === "task_terminal_state" && row.terminalStatus === "completed",
  );
  const requested = options.citedEvents.filter((row) => row.eventType === "tool_requested");
  const results = options.citedEvents.filter((row) => row.eventType === "tool_result");
  const matchedTool = requested.some((request) =>
    results.some((result) => result.toolCallId && result.toolCallId === request.toolCallId),
  );

  if (candidate.memoryType === "semantic" && !userSupport && !toolSupport) {
    return reject("unsupported_semantic_source");
  }
  if (candidate.memoryType === "episodic" && (!terminalSupport || (!userSupport && !toolSupport))) {
    return reject("unsupported_episodic_source");
  }
  if (candidate.memoryType === "procedural" && (!terminalSupport || (!matchedTool && !userSupport))) {
    return reject("unsupported_procedural_source");
  }

  let score = Math.round((candidate.confidence * GATE_WEIGHTS_BPS.confidence) / 100);
  const evidenceKinds = new Set(support.map((row) => row.eventType));
  score += Math.min(GATE_WEIGHTS_BPS.evidence, 1200 + evidenceKinds.size * 500);
  score +=
    candidate.memoryType === "semantic"
      ? 1800
      : candidate.memoryType === "procedural"
        ? 1700
        : 1500;
  score += userSupport ? 2000 : terminalSupport ? 1400 : 900;
  if (options.exactDuplicate) score -= 3000;
  if (options.contradiction) score -= 1800;
  score -= Math.max(0, options.sensitivityPenaltyBps ?? 0);

  if (candidate.validTo) {
    const days = (Date.parse(candidate.validTo) - (options.now ?? new Date()).getTime()) / 86_400_000;
    if (days <= 1) score -= 2000;
  }
  score = Math.max(0, Math.min(10_000, score));
  const threshold = options.minScoreBps ?? getGateMinScoreBps();
  if (options.exactDuplicate) return { status: "rejected", reason: "exact_duplicate", scoreBps: score };
  if (options.contradiction && score < threshold) {
    return { status: "rejected", reason: "contradiction", scoreBps: score };
  }
  if (candidate.validTo && Date.parse(candidate.validTo) - (options.now ?? new Date()).getTime() <= 86_400_000) {
    if (score < threshold) return { status: "rejected", reason: "near_expiry", scoreBps: score };
  }
  return score >= threshold
    ? { status: "accepted", reason: "accepted", scoreBps: score }
    : { status: "rejected", reason: "below_score_threshold", scoreBps: score };
}
