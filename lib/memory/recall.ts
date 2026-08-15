import { renderMemoryContext } from "@/lib/memory/context";
import { postgresRecallRepository } from "@/lib/memory/repository";
import type { RecallRepository, RecallRequest, RecallResult } from "@/lib/memory/types";

const OUTER_DEADLINE_MS = 2_000;
const DECISION_SLOTS = 3;
const GENERAL_SLOTS = 5;
const TOTAL_SLOTS = 8;

export type RecallDependencies = {
  repository?: RecallRepository;
  clock?: () => Date;
  deadlineMs?: number;
  logger?: (event: Record<string, unknown>) => void;
};

export async function searchRankedRecall(
  input: Pick<RecallRequest, "agentId" | "sessionId" | "query" | "kind"> & {
    limit?: number;
    asOf?: Date;
  },
  dependencies: Pick<RecallDependencies, "repository" | "clock" | "deadlineMs"> = {},
) {
  const repository = dependencies.repository ?? postgresRecallRepository;
  const clock = dependencies.clock ?? (() => new Date());
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 10)));
  const result = await withDeadline(
    repository.recall({
      agentId: input.agentId,
      sessionId: input.sessionId,
      query: input.query,
      kind: input.kind,
      asOf: input.asOf ?? clock(),
      includeDecisions: input.kind === undefined,
      decisionLimit: 3,
      generalLimit: limit,
    }),
    dependencies.deadlineMs ?? OUTER_DEADLINE_MS,
  );
  const decisionIntent = /\b(decision|decide|decided|choice|chosen|outcome|rationale)\b/i.test(
    input.query,
  );
  const normalizedQuery = input.query.toLocaleLowerCase("en-US");
  const relevantDecisions = result.decisions.filter(
    (item) =>
      decisionIntent || normalizedQuery.includes(item.subjectKey.toLocaleLowerCase("en-US")),
  );
  return [...relevantDecisions, ...result.general].slice(0, limit);
}

export async function recallForTurn(
  input: Omit<RecallRequest, "asOf"> & { asOf?: Date },
  dependencies: RecallDependencies = {},
): Promise<RecallResult> {
  const repository = dependencies.repository ?? postgresRecallRepository;
  const clock = dependencies.clock ?? (() => new Date());
  const asOf = input.asOf ?? clock();
  const startedAt = clock().getTime();
  const deadlineMs = dependencies.deadlineMs ?? OUTER_DEADLINE_MS;

  try {
    const repositoryResult = await withDeadline(
      repository.recall({
        ...input,
        asOf,
        decisionLimit: Math.min(DECISION_SLOTS, input.decisionLimit ?? DECISION_SLOTS),
        generalLimit: Math.min(20, input.generalLimit ?? 20),
      }),
      deadlineMs,
    );
    const decisions = repositoryResult.decisions.slice(0, DECISION_SLOTS);
    const general = repositoryResult.general.slice(0, GENERAL_SLOTS);
    const candidates = [...decisions, ...general].slice(0, TOTAL_SLOTS);
    const packed = renderMemoryContext(candidates, {
      maxItems: input.maxItems ?? TOTAL_SLOTS,
      maxChars: input.maxChars ?? 4_000,
    });
    const items = packed.items;
    const rejected = [
      ...repositoryResult.decisions.slice(DECISION_SLOTS).map((item) => ({
        id: item.id,
        reason: "decision_slot_cap",
      })),
      ...repositoryResult.general.slice(GENERAL_SLOTS).map((item) => ({
        id: item.id,
        reason: "general_slot_cap",
      })),
      ...candidates
        .filter((candidate) => !items.includes(candidate))
        .map((item) => ({ id: item.id, reason: "character_budget" })),
    ];
    const elapsedMs = Math.max(0, clock().getTime() - startedAt);
    const result: RecallResult = {
      items,
      renderedBlock: packed.block,
      status: items.length > 0 ? "hit" : "miss",
      elapsedMs,
      debug: {
        candidateIds: repositoryResult.candidateIds,
        injectedIds: items.map((item) => item.id),
        rejected,
        scores: Object.fromEntries(items.map((item) => [item.id, item.score])),
      },
    };
    logRecall(result, dependencies.logger);
    return result;
  } catch (error) {
    const result: RecallResult = {
      items: [],
      renderedBlock: "",
      status: "degraded",
      elapsedMs: Math.max(0, clock().getTime() - startedAt),
      debug: {
        candidateIds: [],
        injectedIds: [],
        rejected: [{ id: "repository", reason: errorReason(error) }],
        scores: {},
      },
    };
    logRecall(result, dependencies.logger);
    return result;
  }
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("recall_deadline_exceeded")), deadlineMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorReason(error: unknown) {
  if (error instanceof Error && error.message === "recall_deadline_exceeded") return "timeout";
  if (error instanceof Error && error.message) return error.message.slice(0, 160);
  return "unknown_error";
}

function logRecall(result: RecallResult, logger = console.info) {
  logger({
    event: "memory_recall",
    status: result.status,
    durationMs: result.elapsedMs,
    candidateIds: result.debug.candidateIds,
    injectedIds: result.debug.injectedIds,
    rejected: result.debug.rejected,
  });
}
