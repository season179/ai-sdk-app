import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { jsonSchema, Output, ToolLoopAgent } from "ai";

import { mockTools } from "@/lib/mock-tools";
import { type InstructionTaskPayload, MIN_CHAIN_DELAY_SECONDS } from "@/lib/scheduler/execute";
import type { ScheduledTask } from "@/lib/scheduler/tasks";

/**
 * Structured verdict every instruction round must end with. The model only
 * judges; the worker performs the resulting schedule mutation. All fields are
 * required so strict structured-output providers accept the schema —
 * nextDelaySeconds is ignored when continue is false.
 */
export type InstructionVerdict = {
  statusUpdate: string;
  continue: boolean;
  nextDelaySeconds: number;
};

export class MissingInstructionRunnerEnvError extends Error {
  constructor(readonly variableName: "OPENROUTER_API_KEY" | "OPENROUTER_DEFAULT_MODEL") {
    super(
      `${variableName} is required: the scheduled-task worker runs instruction payloads ` +
        "through OpenRouter. Add it to .env.",
    );
    this.name = "MissingInstructionRunnerEnvError";
  }
}

export function requireInstructionRunnerEnv() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    throw new MissingInstructionRunnerEnvError("OPENROUTER_API_KEY");
  }

  const model = process.env.OPENROUTER_DEFAULT_MODEL?.trim();

  if (!model) {
    throw new MissingInstructionRunnerEnvError("OPENROUTER_DEFAULT_MODEL");
  }

  return { apiKey, model };
}

const verdictSchema = jsonSchema<InstructionVerdict>({
  type: "object",
  properties: {
    statusUpdate: {
      type: "string",
      description: "Concise status update for the user; stored as this round's output.",
    },
    continue: {
      type: "boolean",
      description: "true to run another round, false to stop the chain.",
    },
    nextDelaySeconds: {
      type: "number",
      description: `Seconds until the next round when continue is true (minimum ${MIN_CHAIN_DELAY_SECONDS}). Use 0 when continue is false.`,
    },
  },
  required: ["statusUpdate", "continue", "nextDelaySeconds"],
  additionalProperties: false,
});

const INSTRUCTION_SYSTEM_PROMPT = [
  "You are executing one round of a scheduled check-in on the user's behalf; the user is not present.",
  "Use the available tools to check on whatever the instruction asks, then report.",
  "You cannot schedule, cancel, or modify tasks. The worker process acts on your verdict: continue=true requests another round after nextDelaySeconds; continue=false ends the chain.",
  "Write statusUpdate as the user-facing result of this round — concise and specific, with concrete values from your tool calls.",
  "If this is the final round, wrap up: summarize the overall outcome in statusUpdate and set continue to false.",
].join(" ");

/**
 * Run one round of an instruction chain. Scheduled execution deliberately
 * gets the mock catalog only: no scheduler tools (recursion stays impossible)
 * and no skill tools.
 */
export async function runInstructionRound({
  task,
  payload,
  previousOutput,
}: {
  task: ScheduledTask;
  payload: InstructionTaskPayload;
  previousOutput: unknown;
}): Promise<InstructionVerdict> {
  const { apiKey, model } = requireInstructionRunnerEnv();
  const openrouter = createOpenRouter({ apiKey });

  const agent = new ToolLoopAgent({
    instructions: INSTRUCTION_SYSTEM_PROMPT,
    model: openrouter.chat(model),
    tools: mockTools,
    output: Output.object({ schema: verdictSchema }),
  });

  const result = await agent.generate({ prompt: buildRoundPrompt(task, payload, previousOutput) });

  if (!result.output || typeof result.output.statusUpdate !== "string") {
    throw new Error("Instruction run ended without a usable verdict.");
  }

  return result.output;
}

function buildRoundPrompt(
  task: ScheduledTask,
  payload: InstructionTaskPayload,
  previousOutput: unknown,
) {
  const finalRound = payload.round >= payload.maxRounds;

  return [
    "The user's original instruction for this scheduled task, verbatim:",
    `"${payload.instruction}"`,
    "",
    `The current UTC time is ${new Date().toISOString()}.`,
    `This is round ${payload.round} of at most ${payload.maxRounds}.${finalRound ? " This is the final round: wrap up and set continue to false." : ""}`,
    `The chain started at ${task.createdAt}${payload.cadenceSeconds ? ` with an intended cadence of about ${payload.cadenceSeconds} seconds between rounds` : ""}.`,
    previousOutput === null || previousOutput === undefined
      ? "This is the first round; there is no previous output."
      : `Previous round output:\n${JSON.stringify(previousOutput)}`,
    "",
    "Carry out this round now and end with your verdict.",
  ].join("\n");
}
