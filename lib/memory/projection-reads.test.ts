import { afterEach, describe, expect, it, vi } from "vitest";

import { runProjectionReads } from "@/lib/memory/projection-reads";
import { recallForTurn } from "@/lib/memory/recall";
import type { RecallRepository, RecallResult } from "@/lib/memory/types";

afterEach(() => vi.useRealTimers());

describe("shared projection-read deadline", () => {
  it("starts catalog, activation, and recall concurrently and returns stream fallbacks on budget", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    let recallAborted = false;
    const blocked = (name: string) => async () => {
      started.push(name);
      return new Promise<string>(() => undefined);
    };
    const repository: RecallRepository = {
      recall: vi.fn(
        (request) =>
          new Promise<never>(() => {
            started.push("recall");
            request.signal?.addEventListener("abort", () => {
              recallAborted = true;
            });
          }),
      ),
    };

    const pending = runProjectionReads<{
      catalog: string;
      activation: string;
      recall: RecallResult | null;
    }>(
      {
        catalog: blocked("catalog"),
        activation: blocked("activation"),
        recall: ({ signal, deadlineAt }) =>
          recallForTurn(
            { agentId: "agent", query: "unreachable repository" },
            { repository, signal, deadlineAt, logger: vi.fn() },
          ),
      },
      { catalog: "", activation: "clean", recall: null },
      { deadlineMs: 2_000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started.sort()).toEqual(["activation", "catalog", "recall"]);
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({
      catalog: "",
      activation: "clean",
      recall: { status: "degraded", items: [] },
    });
    expect(settled).toBe(true);
    expect(recallAborted).toBe(true);
  });

  it("retains reads that finish before another optional repository times out", async () => {
    vi.useFakeTimers();
    const pending = runProjectionReads(
      {
        catalog: async () => "catalog",
        activation: async () => "activated",
        recall: async () => new Promise<string>(() => undefined),
      },
      { catalog: "", activation: "clean", recall: "" },
      { deadlineMs: 25 },
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({
      catalog: "catalog",
      activation: "activated",
      recall: "",
    });
  });
});
