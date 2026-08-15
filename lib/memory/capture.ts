import type { StepResult, UIMessage } from "ai";

import type { TraceTerminalStatus } from "@/db/schema";
import { getTraceRetentionDays } from "@/lib/memory/config";
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
  return {
    ...input,
    agentId: context.agentId,
    traceId: context.traceId,
    sessionId: context.sessionId ?? null,
    taskId: context.taskId ?? null,
    pgBossJobId: context.pgBossJobId ?? null,
    payload: sanitized.payload,
    contentHash: sanitized.contentHash,
    artifact: sanitized.artifact,
    sensitivityClass: sanitized.sensitivityClass,
    occurredAt,
    expiresAt: input.retentionClass === "audit" ? null : expiresAt(occurredAt),
  };
}

function visibleText(message: Pick<UIMessage, "parts">): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
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
    payload: { messageId: message.id, text: visibleText(message) },
    idempotencyKey: `chat:${context.sessionId}:message:${message.id}:user`,
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
    payload: { messageId: message.id, text: visibleText(message) },
    idempotencyKey: `trace:${context.traceId}:message:${message.id}:assistant`,
    retentionClass: "standard",
  });
}

export function mapStepToTraceEvents(
  context: TraceContext,
  step: StepResult<any>,
): TraceEventInput[] {
  const base = step.stepNumber * 100 + 100;
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
        text: step.text,
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
    output.push(
      event(context, {
        sequenceNo: base + 50 + index,
        spanId: step.callId,
        toolCallId: result.toolCallId,
        eventType: "tool_result",
        actor: "tool",
        trustClass: "tool_observation",
        payload: { toolName: result.toolName, output: result.output ?? null },
        idempotencyKey: `trace:${context.traceId}:tool:${result.toolCallId}:result`,
        retentionClass: "standard",
      }),
    );
  });

  return output;
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
      trustClass: "tool_observation",
      payload: { toolName, output },
      idempotencyKey: `trace:${context.traceId}:tool:result`,
      retentionClass: "audit",
    }),
  ];
}
