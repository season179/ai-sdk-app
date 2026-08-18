import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const modelMocks = vi.hoisted(() => ({
  chat: vi.fn((..._args: unknown[]) => ({ model: "configured" })),
  generateText: vi.fn(),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: (options: unknown) => ({
    chat: (modelId: unknown, settings: unknown) => {
      modelMocks.chat(options, modelId, settings);
      return { model: "configured" };
    },
  }),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: modelMocks.generateText };
});

import { buildDocumentFromEntries } from "@/lib/memory-document/repository";
import type { MemoryDocumentEntry, MemoryRewriteOutput } from "@/lib/memory-document/types";
import {
  applyMemoryTimestampRule,
  MemoryWriteInputError,
  requestMemoryRewrite,
  writeMemoryDocument,
} from "@/lib/memory-document/writer";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const KEY = "mem_00000000000000000000000000000001";
const NEW_KEY = "mem_00000000000000000000000000000002";
const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-06-22T10:11:12.345Z";

function stored(): MemoryDocumentEntry {
  return {
    key: KEY,
    updatedAt: OLD,
    summary: "The user prefers concise responses.",
    details: [
      { timestamp: OLD, text: "Keep answers brief." },
      { timestamp: "2026-02-01T00:00:00.000Z", text: "Lead with the answer." },
    ],
  };
}

function current() {
  return buildDocumentFromEntries(AGENT_ID, 4, [stored()]);
}

describe("memory timestamp rule", () => {
  it("preserves byte-identical entries and every timestamp", () => {
    const prior = stored();
    const result = applyMemoryTimestampRule(
      [prior],
      [{ key: KEY, summary: prior.summary, details: prior.details.map((detail) => detail.text) }],
      { now: NOW },
    );
    expect(result.entries[0]).toBe(prior);
  });

  it("refreshes updatedAt while retaining exact detail timestamps", () => {
    const prior = stored();
    const result = applyMemoryTimestampRule(
      [prior],
      [
        {
          key: KEY,
          summary: "The user prefers concise technical responses.",
          details: ["Lead with the answer.", "Include one example."],
        },
      ],
      { now: NOW },
    );
    expect(result.entries[0]).toEqual({
      key: KEY,
      updatedAt: NOW,
      summary: "The user prefers concise technical responses.",
      details: [
        { timestamp: "2026-02-01T00:00:00.000Z", text: "Lead with the answer." },
        { timestamp: NOW, text: "Include one example." },
      ],
    });
  });

  it("mints new keys and applies one server timestamp", () => {
    const result = applyMemoryTimestampRule(
      [],
      [{ key: null, summary: "The user likes tea.", details: ["Green tea is preferred."] }],
      { now: NOW, mintKey: () => NEW_KEY },
    );
    expect(result.newKeys).toEqual([NEW_KEY]);
    expect(result.entries[0]).toEqual({
      key: NEW_KEY,
      updatedAt: NOW,
      summary: "The user likes tea.",
      details: [{ timestamp: NOW, text: "Green tea is preferred." }],
    });
  });
});

describe("memory writer statuses", () => {
  const read = vi.fn(async () => current());
  const commit = vi.fn(async () => ({ status: "applied" as const, version: 5 }));
  const options = {
    agentId: AGENT_ID,
    sessionId: "00000000-0000-0000-0000-000000000002",
    messageId: "msg-1",
    modelId: "openai/test",
    apiKey: "secret-not-memory-content",
  };

  beforeEach(() => {
    read.mockClear();
    commit.mockClear();
  });

  it("returns clarification without persistence", async () => {
    const rewrite = vi.fn(async () => ({
      status: "needs_clarification" as const,
      clarificationQuestion: "Which saved preference should be changed?",
      clarificationCandidates: [{ key: KEY, summary: stored().summary }],
    }));
    const result = await writeMemoryDocument("change my response preference", options, {
      read,
      commit,
      rewrite,
    });
    expect(result).toMatchObject({ status: "needs_clarification", durable: false, version: 4 });
    expect(commit).not.toHaveBeenCalled();
  });

  it("requires no_op output to match and persists nothing", async () => {
    const rewrite = vi.fn(
      async (): Promise<MemoryRewriteOutput> => ({
        status: "no_op",
        entries: [
          {
            key: KEY,
            summary: stored().summary,
            details: stored().details.map((item) => item.text),
          },
        ],
      }),
    );
    const result = await writeMemoryDocument("keep memory unchanged", options, {
      read,
      commit,
      rewrite,
    });
    expect(result).toMatchObject({ status: "no_op", version: 4, entryCount: 1 });
    expect(commit).not.toHaveBeenCalled();
  });

  it("normalizes identical applied output to no_op", async () => {
    const rewrite = vi.fn(
      async (): Promise<MemoryRewriteOutput> => ({
        status: "applied",
        entries: [
          {
            key: KEY,
            summary: stored().summary,
            details: stored().details.map((item) => item.text),
          },
        ],
      }),
    );
    const result = await writeMemoryDocument("save the same preference", options, {
      read,
      commit,
      rewrite,
      now: () => new Date(NOW),
    });
    expect(result.status).toBe("no_op");
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits one changed applied rewrite with bounded metadata", async () => {
    const rewrite = vi.fn(
      async (): Promise<MemoryRewriteOutput> => ({
        status: "applied",
        entries: [
          {
            key: KEY,
            summary: "The user prefers concise technical responses.",
            details: stored().details.map((item) => item.text),
          },
        ],
      }),
    );
    const result = await writeMemoryDocument("make my preference technical", options, {
      read,
      commit,
      rewrite,
      now: () => new Date(NOW),
    });
    expect(result).toMatchObject({
      status: "applied",
      durable: true,
      version: 5,
      affectedKeys: [KEY],
      newKeys: [],
      droppedKeys: [],
      changedSummaries: [{ key: KEY, summary: "The user prefers concise technical responses." }],
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        expectedVersion: 4,
        source: "tool",
        now: new Date(NOW),
      }),
    );
  });

  it("rejects an applied rewrite that would erase the whole non-empty document", async () => {
    const rewrite = vi.fn(
      async (): Promise<MemoryRewriteOutput> => ({ status: "applied", entries: [] }),
    );
    const result = await writeMemoryDocument("forget everything about me", options, {
      read,
      commit,
      rewrite,
    });
    expect(result).toMatchObject({ status: "invalid_output", durable: false, version: 4 });
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects unsafe intent before reading or calling the model", async () => {
    const rewrite = vi.fn();
    await expect(
      writeMemoryDocument("remember that my password is hunter2", options, { read, rewrite }),
    ).rejects.toBeInstanceOf(MemoryWriteInputError);
    expect(read).not.toHaveBeenCalled();
    expect(rewrite).not.toHaveBeenCalled();
  });
});

describe("memory rewrite model call", () => {
  it("uses the resolved model with reasoning off and exact timeout settings", async () => {
    const abort = new AbortController();
    const output: MemoryRewriteOutput = { status: "applied", entries: [] };
    modelMocks.generateText.mockResolvedValueOnce({ output });
    await expect(
      requestMemoryRewrite(
        { intent: "forget all saved preferences", current: [stored()] },
        { modelId: "anthropic/resolved", apiKey: "api-key", abortSignal: abort.signal },
      ),
    ).resolves.toEqual(output);
    expect(modelMocks.chat).toHaveBeenCalledWith({ apiKey: "api-key" }, "anthropic/resolved", {
      reasoning: { enabled: false, effort: "none", exclude: true },
    });
    expect(modelMocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { model: "configured" },
        maxOutputTokens: 8_000,
        timeout: 45_000,
        abortSignal: abort.signal,
      }),
    );
    expect(modelMocks.generateText).toHaveBeenCalledTimes(1);
  });
});
