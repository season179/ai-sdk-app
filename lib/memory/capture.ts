import type { StepResult, UIMessage } from "ai";

import type { TraceTerminalStatus } from "@/db/schema";
import { getTraceRetentionDays } from "@/lib/memory/config";
import { DERIVATIVE_RETRIEVAL_TOOLS, redactReadProjection } from "@/lib/memory/projection-safety";
import { sanitizeTracePayload } from "@/lib/memory/redaction";
import type { TraceEventInput } from "@/lib/memory/trace";

export type TraceContext = {
  agentId: string;
  traceId: string;
  sessionId?: string | null;
  taskId?: string | null;
  pgBossJobId?: string | null;
  occurredAt?: Date;
};

function expiresAt(now: Date): Date {
  return new Date(now.getTime() + getTraceRetentionDays() * 86_400_000);
}

function event(
  context: TraceContext,
  input: Omit<
    TraceEventInput,
    | "agentId"
    | "traceId"
    | "sessionId"
    | "taskId"
    | "pgBossJobId"
    | "payload"
    | "contentHash"
    | "artifact"
    | "sensitivityClass"
    | "occurredAt"
    | "expiresAt"
  > & { payload: Record<string, unknown>; occurredAt?: Date },
): TraceEventInput {
  const occurredAt = input.occurredAt ?? context.occurredAt ?? new Date();
  const sanitized = sanitizeTracePayload(input.payload);
  const eventExpiresAt = input.retentionClass === "audit" ? null : expiresAt(occurredAt);
  return {
    ...input,
    agentId: context.agentId,
    traceId: context.traceId,
    sessionId: context.sessionId ?? null,
    taskId: context.taskId ?? null,
    pgBossJobId: context.pgBossJobId ?? null,
    payload: sanitized.payload,
    contentHash: sanitized.contentHash,
    artifact: sanitized.artifact ? { ...sanitized.artifact, expiresAt: eventExpiresAt } : undefined,
    sensitivityClass: sanitized.sensitivityClass,
    occurredAt,
    expiresAt: eventExpiresAt,
  };
}

function visibleText(message: Pick<UIMessage, "parts">) {
  return redactReadProjection(
    message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim(),
  );
}

export function buildUserMessageEvent(
  context: TraceContext,
  message: Pick<UIMessage, "id" | "role" | "parts">,
): TraceEventInput {
  return event(context, {
    sequenceNo: 0,
    sourceMessageId: message.id,
    eventType: "user_message",
    actor: "user",
    trustClass: "user_assertion",
    payload: messagePayload(message),
    // Attempt membership is independent from grounded-observation source
    // identity, so a successful retry carries its own user evidence event.
    idempotencyKey: `trace:${context.traceId}:message:${message.id}:user`,
    retentionClass: "standard",
  });
}

export function buildAssistantMessageEvent(
  context: TraceContext,
  message: Pick<UIMessage, "id" | "role" | "parts">,
  sequenceNo = 900_000,
): TraceEventInput {
  return event(context, {
    sequenceNo,
    sourceMessageId: message.id,
    eventType: "assistant_message",
    actor: "assistant",
    trustClass: "model_inference",
    payload: messagePayload(message),
    idempotencyKey: `trace:${context.traceId}:message:${message.id}:assistant`,
    retentionClass: "standard",
  });
}

export function mapStepToTraceEvents(
  context: TraceContext,
  step: StepResult<any>,
): TraceEventInput[] {
  const base = step.stepNumber * 100 + 100;
  const generation = redactReadProjection(step.text);
  const output: TraceEventInput[] = [
    event(context, {
      sequenceNo: base,
      spanId: step.callId,
      eventType: "model_generation",
      actor: "assistant",
      trustClass: "model_inference",
      payload: {
        callId: step.callId,
        stepNumber: step.stepNumber,
        provider: step.model.provider,
        modelId: step.model.modelId,
        text: generation.text,
        ...(generation.contaminated
          ? { projectionContaminated: true, projectionMarkers: generation.markers }
          : {}),
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        usage: step.usage,
      },
      idempotencyKey: `trace:${context.traceId}:step:${step.stepNumber}:generation`,
      retentionClass: "standard",
    }),
  ];

  step.toolCalls.forEach((rawCall, index) => {
    const call = rawCall as unknown as {
      toolCallId: string;
      toolName: string;
      input?: unknown;
    };
    output.push(
      event(context, {
        sequenceNo: base + 10 + index,
        spanId: step.callId,
        toolCallId: call.toolCallId,
        eventType: "tool_requested",
        actor: "assistant",
        trustClass: "model_inference",
        payload: { toolName: call.toolName, input: call.input ?? null },
        idempotencyKey: `trace:${context.traceId}:tool:${call.toolCallId}:request`,
        retentionClass: "standard",
      }),
    );
  });

  step.toolResults.forEach((rawResult, index) => {
    const result = rawResult as unknown as {
      toolCallId: string;
      toolName: string;
      output?: unknown;
    };
    const derivative = DERIVATIVE_RETRIEVAL_TOOLS.has(result.toolName);
    output.push(
      event(context, {
        sequenceNo: base + 50 + index,
        spanId: step.callId,
        toolCallId: result.toolCallId,
        eventType: "tool_result",
        actor: "tool",
        trustClass: derivative ? "third_party_content" : "tool_observation",
        payload: {
          toolName: result.toolName,
          outcome: "success",
          output: result.output ?? null,
          ...(derivative ? { derivative: true, derivativeSource: "read_projection" } : {}),
        },
        idempotencyKey: `trace:${context.traceId}:tool:${result.toolCallId}:result`,
        retentionClass: "standard",
      }),
    );
  });

  const content = (step as unknown as { content?: unknown[] }).content ?? [];
  content.forEach((part, index) => {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "tool-error") {
      return;
    }
    const toolError = part as {
      toolCallId?: unknown;
      toolName?: unknown;
      error?: unknown;
    };
    if (typeof toolError.toolCallId !== "string") return;
    const error =
      toolError.error instanceof Error
        ? toolError.error.message
        : typeof toolError.error === "string"
          ? toolError.error
          : "Tool execution failed.";
    const toolName = typeof toolError.toolName === "string" ? toolError.toolName : "unknown";
    const derivative = DERIVATIVE_RETRIEVAL_TOOLS.has(toolName);
    output.push(
      event(context, {
        sequenceNo: base + 70 + index,
        spanId: step.callId,
        toolCallId: toolError.toolCallId,
        eventType: "tool_result",
        actor: "tool",
        trustClass: derivative ? "third_party_content" : "tool_observation",
        payload: {
          toolName,
          outcome: "error",
          error: error.slice(0, 4_000),
          ...(derivative ? { derivative: true, derivativeSource: "read_projection" } : {}),
        },
        idempotencyKey: `trace:${context.traceId}:tool:${toolError.toolCallId}:error`,
        retentionClass: "standard",
      }),
    );
  });

  return output.sort((a, b) => a.sequenceNo - b.sequenceNo);
}

function messagePayload(message: Pick<UIMessage, "id" | "parts">) {
  const visible = visibleText(message);
  return {
    messageId: message.id,
    text: visible.text,
    ...(visible.contaminated
      ? { projectionContaminated: true, projectionMarkers: visible.markers }
      : {}),
  };
}

export function buildTerminalEvent(
  context: TraceContext,
  status: TraceTerminalStatus,
  input: { finishReason?: string | null; error?: string | null; sequenceNo?: number } = {},
): TraceEventInput {
  return event(context, {
    sequenceNo: input.sequenceNo ?? 999_999,
    eventType: "task_terminal_state",
    actor: context.taskId ? "worker" : "system",
    trustClass: "system_record",
    terminalStatus: status,
    payload: {
      status,
      finishReason: input.finishReason ?? null,
      error: input.error?.slice(0, 4000) ?? null,
    },
    idempotencyKey: `trace:${context.traceId}:terminal:${status}`,
    retentionClass: "audit",
  });
}

export function buildScheduledToolEvents(
  context: TraceContext,
  toolName: string,
  args: Record<string, unknown>,
  output: unknown,
): TraceEventInput[] {
  const toolCallId = `${context.traceId}:tool`;
  return [
    event(context, {
      sequenceNo: 10,
      toolCallId,
      eventType: "tool_requested",
      actor: "scheduler",
      trustClass: "system_record",
      payload: { toolName, input: args },
      idempotencyKey: `trace:${context.traceId}:tool:request`,
      retentionClass: "audit",
    }),
    event(context, {
      sequenceNo: 20,
      toolCallId,
      eventType: "tool_result",
      actor: "tool",
      trustClass: DERIVATIVE_RETRIEVAL_TOOLS.has(toolName)
        ? "third_party_content"
        : "tool_observation",
      payload: {
        toolName,
        output,
        ...(DERIVATIVE_RETRIEVAL_TOOLS.has(toolName)
          ? { derivative: true, derivativeSource: "read_projection" }
          : {}),
      },
      idempotencyKey: `trace:${context.traceId}:tool:result`,
      retentionClass: "audit",
    }),
  ];
}
