import type { StepResult } from "ai";
import { describe, expect, it } from "vitest";

import { buildTerminalEvent, mapStepToTraceEvents } from "@/lib/memory/capture";

const context = {
  agentId: "00000000-0000-0000-0000-000000000001",
  traceId: "trace-capture-test",
  sessionId: "00000000-0000-4000-8000-000000000001",
};

function fakeStep(): StepResult<any> {
  return {
    callId: "call-1",
    stepNumber: 2,
    model: { provider: "openrouter", modelId: "test/model" },
    text: "Visible answer",
    reasoning: [{ type: "reasoning", text: "private chain" }],
    reasoningText: "private chain",
    toolCalls: [{ toolCallId: "tool-1", toolName: "weather", input: { city: "Paris" } }],
    toolResults: [{ toolCallId: "tool-1", toolName: "weather", output: { temp: 20 } }],
    finishReason: "tool-calls",
    rawFinishReason: "tool_calls",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    request: { body: { messages: ["recalled context"] } },
    response: {},
  } as unknown as StepResult<any>;
}

describe("AI SDK trace capture mapping", () => {
  it("emits model, tool request, and paired tool result in stable order", () => {
    const events = mapStepToTraceEvents(context, fakeStep());
    expect(events.map((item) => item.eventType)).toEqual([
      "model_generation",
      "tool_requested",
      "tool_result",
    ]);
    expect(events[1].toolCallId).toBe("tool-1");
    expect(events[2].toolCallId).toBe("tool-1");
    expect(events.map((item) => item.sequenceNo)).toEqual([300, 310, 350]);
  });

  it("never stores reasoning, provider request bodies, or recalled messages", () => {
    const serialized = JSON.stringify(mapStepToTraceEvents(context, fakeStep()));
    expect(serialized).not.toContain("private chain");
    expect(serialized).not.toContain("recalled context");
    expect(serialized).not.toContain("requestBody");
  });

  it("builds stable terminal keys for every state", () => {
    for (const status of ["completed", "failed", "interrupted", "skipped"] as const) {
      const first = buildTerminalEvent(context, status);
      const second = buildTerminalEvent(context, status);
      expect(first.terminalStatus).toBe(status);
      expect(first.idempotencyKey).toBe(second.idempotencyKey);
    }
  });
});
