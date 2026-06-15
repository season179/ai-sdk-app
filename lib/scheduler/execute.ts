import { executeMockTool, getMockToolSpec } from "@/lib/mock-tools";

/**
 * Discriminated execution payload stored on each scheduled task. New kinds
 * become new dispatcher branches, not migrations.
 *
 * - `tool_call` executes one catalog tool with fixed arguments.
 * - `instruction` runs a free-form instruction through an agent loop at fire
 *   time. The model only judges; the worker performs every schedule mutation
 *   based on the structured verdict, so scheduled execution never holds
 *   scheduler tools.
 */
export type ToolCallTaskPayload = {
  kind: "tool_call";
  toolName: string;
  arguments: Record<string, unknown>;
};

export type InstructionTaskPayload = {
  kind: "instruction";
  instruction: string;
  /** 1-based round number of the next fire; the worker advances it per run. */
  round: number;
  /** Hard cap: the worker refuses to schedule past this, whatever the verdict. */
  maxRounds: number;
  /** Intended seconds between self-chained rounds; fallback when the verdict omits a delay. */
  cadenceSeconds: number | null;
};

export type ScheduledTaskPayload = ToolCallTaskPayload | InstructionTaskPayload;

export const DEFAULT_INSTRUCTION_MAX_ROUNDS = 10;
export const INSTRUCTION_MAX_ROUNDS_LIMIT = 100;
/** Floor on chain delays so a confused model cannot tighten the loop. */
export const MIN_CHAIN_DELAY_SECONDS = 30;
export const MAX_CHAIN_DELAY_SECONDS = 24 * 60 * 60;
export const DEFAULT_CHAIN_DELAY_SECONDS = 60;

export class ScheduledPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledPayloadError";
  }
}

export function parseScheduledTaskPayload(value: unknown): ScheduledTaskPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScheduledPayloadError("Task payload must be an object.");
  }

  const payload = value as Record<string, unknown>;

  if (payload.kind === "tool_call") {
    return parseToolCallPayload(payload);
  }

  if (payload.kind === "instruction") {
    return parseInstructionPayload(payload);
  }

  throw new ScheduledPayloadError("Task payload kind must be 'tool_call' or 'instruction'.");
}

function parseToolCallPayload(payload: Record<string, unknown>): ToolCallTaskPayload {
  const toolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";

  if (!toolName) {
    throw new ScheduledPayloadError("Task payload requires a non-empty toolName.");
  }

  if (!getMockToolSpec(toolName)) {
    throw new ScheduledPayloadError(
      `Tool '${toolName}' is not in the tool catalog, so it cannot be scheduled.`,
    );
  }

  const args = payload.arguments;

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ScheduledPayloadError("Task payload requires an 'arguments' object.");
  }

  return {
    kind: "tool_call",
    toolName,
    arguments: args as Record<string, unknown>,
  };
}

function parseInstructionPayload(payload: Record<string, unknown>): InstructionTaskPayload {
  const instruction = typeof payload.instruction === "string" ? payload.instruction.trim() : "";

  if (!instruction) {
    throw new ScheduledPayloadError("Instruction payloads require a non-empty instruction.");
  }

  const round = parseRoundField(payload.round, 1, "round");
  const maxRounds = parseRoundField(payload.maxRounds, DEFAULT_INSTRUCTION_MAX_ROUNDS, "maxRounds");

  if (maxRounds > INSTRUCTION_MAX_ROUNDS_LIMIT) {
    throw new ScheduledPayloadError(`maxRounds cannot exceed ${INSTRUCTION_MAX_ROUNDS_LIMIT}.`);
  }

  if (round > maxRounds) {
    throw new ScheduledPayloadError("round cannot exceed maxRounds.");
  }

  return {
    kind: "instruction",
    instruction,
    round,
    maxRounds,
    cadenceSeconds: parseCadenceSeconds(payload.cadenceSeconds),
  };
}

function parseRoundField(value: unknown, defaultValue: number, field: string) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ScheduledPayloadError(`${field} must be a positive integer.`);
  }

  return value;
}

function parseCadenceSeconds(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScheduledPayloadError("cadenceSeconds must be a number.");
  }

  if (value < MIN_CHAIN_DELAY_SECONDS || value > MAX_CHAIN_DELAY_SECONDS) {
    throw new ScheduledPayloadError(
      `cadenceSeconds must be between ${MIN_CHAIN_DELAY_SECONDS} and ${MAX_CHAIN_DELAY_SECONDS} seconds.`,
    );
  }

  return Math.round(value);
}

/** Clamp a chain delay from a verdict or payload to the allowed window. */
export function clampChainDelaySeconds(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CHAIN_DELAY_SECONDS;
  }

  return Math.min(MAX_CHAIN_DELAY_SECONDS, Math.max(MIN_CHAIN_DELAY_SECONDS, Math.round(value)));
}

/**
 * Executes a tool_call payload. Instruction payloads run through
 * `runInstructionRound` in the worker instead: they need task context
 * (round, previous output) and drive schedule mutations from the verdict.
 */
export async function executeScheduledTaskPayload(payload: ToolCallTaskPayload) {
  const output = executeMockTool(payload.toolName, payload.arguments);

  if (!output) {
    throw new Error(`Tool '${payload.toolName}' is no longer available.`);
  }

  return output;
}
