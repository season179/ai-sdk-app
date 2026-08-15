import { afterEach, describe, expect, it, vi } from "vitest";

import { recallForTurn, searchRankedRecall } from "@/lib/memory/recall";
import { PostgresRecallRepository } from "@/lib/memory/repository";
import type {
  DecisionRecallItem,
  GeneralRecallItem,
  RecallRepository,
  RecallScoreComponents,
} from "@/lib/memory/types";

const SCORE: RecallScoreComponents = {
  lexicalRank: 1,
  trigramRank: null,
  rrf: 0.01,
  normalizedRrf: 0.61,
  importance: 0.5,
  confidence: 0.8,
  freshness: 1,
  riskPenalty: 0,
  composite: 0.7,
};

afterEach(() => vi.useRealTimers());

describe("recallForTurn", () => {
  it("fails open when the repository rejects", async () => {
    const repository: RecallRepository = {
      recall: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const result = await recallForTurn(
      { agentId: "agent", query: "substantive" },
      { repository, logger: vi.fn() },
    );
    expect(result.status).toBe("degraded");
    expect(result.items).toEqual([]);
    expect(result.renderedBlock).toBe("");
  });

  it("bounds a never-resolving repository by the outer deadline", async () => {
    vi.useFakeTimers();
    const repository: RecallRepository = { recall: () => new Promise(() => undefined) };
    const pending = recallForTurn(
      { agentId: "agent", query: "substantive" },
      { repository, deadlineMs: 2_000, logger: vi.fn() },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ status: "degraded", items: [] });
  });

  it("keeps decisions first and enforces three/five/eight slot caps", async () => {
    const decisions = Array.from({ length: 5 }, (_, index) => decision(`d${index}`));
    const general = Array.from({ length: 8 }, (_, index) => memory(`m${index}`));
    const repository: RecallRepository = {
      recall: vi.fn().mockResolvedValue({
        decisions,
        general,
        candidateIds: [...decisions, ...general].map((item) => item.id),
      }),
    };
    const result = await recallForTurn(
      { agentId: "agent", query: "substantive" },
      { repository, logger: vi.fn() },
    );
    expect(result.items).toHaveLength(8);
    expect(result.items.slice(0, 3).every((item) => item.category === "decision")).toBe(true);
    expect(result.items.slice(3).every((item) => item.category === "memory")).toBe(true);
    expect(result.debug.rejected).toContainEqual({ id: "d3", reason: "decision_slot_cap" });
    expect(result.debug.rejected).toContainEqual({ id: "m5", reason: "general_slot_cap" });
  });

  it("reports a miss without injecting debug scores into a block", async () => {
    const logger = vi.fn();
    const repository: RecallRepository = {
      recall: vi.fn().mockResolvedValue({ decisions: [], general: [], candidateIds: [] }),
    };
    const result = await recallForTurn(
      { agentId: "agent", query: "substantive" },
      { repository, logger },
    );
    expect(result).toMatchObject({ status: "miss", renderedBlock: "", items: [] });
    expect(logger).toHaveBeenCalledTimes(1);
  });
});

describe("recall checkout cancellation", () => {
  it("releases a checkout won after timeout without executing SQL", async () => {
    vi.useFakeTimers();
    let resolveCheckout: ((client: unknown) => void) | undefined;
    const checkout = new Promise<unknown>((resolve) => {
      resolveCheckout = resolve;
    });
    const query = vi.fn();
    const release = vi.fn();
    const repository = new PostgresRecallRepository({
      pool: { connect: vi.fn(() => checkout) } as never,
    });
    const controller = new AbortController();
    const pending = repository.recall({
      agentId: "00000000-0000-0000-0000-000000000001",
      query: "queued recall",
      asOf: new Date(),
      signal: controller.signal,
      deadlineAt: Date.now() + 20,
    });
    const rejected = expect(pending).rejects.toThrow("recall_deadline_exceeded");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    controller.abort();
    resolveCheckout?.({ query, release });
    await vi.advanceTimersByTimeAsync(0);
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("searchRankedRecall", () => {
  it("includes decisions only for deterministic decision intent or subject relevance", async () => {
    const repository: RecallRepository = {
      recall: vi.fn().mockResolvedValue({
        decisions: [decision("deployment")],
        general: [memory("m1")],
        candidateIds: ["deployment", "m1"],
      }),
    };
    expect(
      (
        await searchRankedRecall(
          { agentId: "agent", query: "what deployment decision was chosen?" },
          { repository },
        )
      ).map((item) => item.category),
    ).toEqual(["decision", "memory"]);
    expect(
      (
        await searchRankedRecall({ agentId: "agent", query: "unrelated telemetry" }, { repository })
      ).map((item) => item.category),
    ).toEqual(["memory"]);
  });

  it("bounds tool results to twenty and suppresses decisions for a kind filter", async () => {
    const repository: RecallRepository = {
      recall: vi.fn().mockResolvedValue({
        decisions: [decision("d1")],
        general: Array.from({ length: 20 }, (_, index) => memory(`m${index}`)),
        candidateIds: [],
      }),
    };
    const result = await searchRankedRecall(
      { agentId: "agent", query: "decision", kind: "fact", limit: 99 },
      { repository },
    );
    expect(result).toHaveLength(20);
    expect(repository.recall).toHaveBeenCalledWith(
      expect.objectContaining({ includeDecisions: false, generalLimit: 20 }),
    );
  });
});

function decision(id: string): DecisionRecallItem {
  return {
    category: "decision",
    id,
    lineageId: id,
    type: "decision",
    sourceKind: "decision",
    summary: `option ${id}`,
    status: "open",
    subjectKey: id,
    rationale: "reason",
    outcome: null,
    eventDate: "2026-01-01T00:00:00.000Z",
    validDate: null,
    provenanceTraceIds: [],
    authority: "user",
    confidence: 80,
    score: SCORE,
  };
}

function memory(id: string): GeneralRecallItem {
  return {
    category: "memory",
    id,
    versionId: `v-${id}`,
    lineageId: id,
    type: "fact",
    memoryType: "semantic",
    sourceKind: "user",
    summary: `memory ${id}`,
    status: "approved",
    eventDate: "2026-01-01T00:00:00.000Z",
    validDate: null,
    provenanceTraceIds: [],
    authority: "user",
    confidence: 80,
    contentKey: id,
    score: SCORE,
  };
}
