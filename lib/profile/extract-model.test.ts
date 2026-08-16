import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => ({ chat: () => ({}) }),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: mocks.generateText };
});

import { NoOutputGeneratedError } from "ai";
import {
  extractProfileOperations,
  PROFILE_EXTRACTION_MAX_OUTPUT_TOKENS,
} from "@/lib/profile/extract";
import type { ProfileSynthesisSnapshot } from "@/lib/profile/types";

function snapshot(content = "I like pizza."): ProfileSynthesisSnapshot {
  const at = new Date("2026-02-01T00:00:00Z");
  return {
    agentId: "00000000-0000-0000-0000-000000000020",
    expectedVersionId: null,
    expectedVersionNo: 0,
    expectedDirtyGeneration: 1,
    synthesizedGeneration: 0,
    lowerBounds: {
      observation: { createdAt: null, id: null },
      memoryVersion: { createdAt: null, id: null },
    },
    upperBounds: {
      observation: { createdAt: at.toISOString(), id: "00000000-0000-0000-0000-000000000021" },
      memoryVersion: { createdAt: null, id: null },
    },
    currentVersion: null,
    currentSources: [],
    observationDeltas: [
      {
        id: "00000000-0000-0000-0000-000000000021",
        traceEventId: "00000000-0000-0000-0000-000000000023",
        sessionId: "00000000-0000-0000-0000-000000000024",
        content,
        createdAt: at,
      },
    ],
    memoryVersionDeltas: [],
    activeMemories: [],
    tombstones: [],
  };
}

beforeEach(() => {
  mocks.generateText.mockReset();
});

describe("profile extraction provider failures", () => {
  it("retries NoOutputGeneratedError with a larger output budget", async () => {
    mocks.generateText
      .mockRejectedValueOnce(new NoOutputGeneratedError())
      .mockResolvedValueOnce({ output: { operations: [] } });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await extractProfileOperations(snapshot(), {
      apiKey: "test-key",
      model: "test/model",
    });

    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(mocks.generateText.mock.calls[0][0].maxOutputTokens).toBe(
      PROFILE_EXTRACTION_MAX_OUTPUT_TOKENS,
    );
    expect(mocks.generateText.mock.calls[1][0].maxOutputTokens).toBeGreaterThan(
      PROFILE_EXTRACTION_MAX_OUTPUT_TOKENS,
    );
    expect(result.operations[0]?.sentence).toBe("The user likes pizza.");
    warning.mockRestore();
  });

  it("uses the safe direct-preference fallback after repeated empty provider output", async () => {
    mocks.generateText.mockRejectedValue(new NoOutputGeneratedError());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      extractProfileOperations(snapshot(), { apiKey: "test-key", model: "test/model" }),
    ).resolves.toMatchObject({
      operations: [{ sentence: "The user likes pizza." }],
    });
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("does not silently consume unsupported evidence after repeated empty output", async () => {
    mocks.generateText.mockRejectedValue(new NoOutputGeneratedError());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      extractProfileOperations(snapshot("I visited a museum today."), {
        apiKey: "test-key",
        model: "test/model",
      }),
    ).rejects.toBeInstanceOf(NoOutputGeneratedError);
    warning.mockRestore();
  });
});
