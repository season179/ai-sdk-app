import "@/lib/scheduler/load-env";

import type { JobWithMetadata } from "pg-boss";

import { getDb } from "@/db";
import { notifySessionAppended } from "@/lib/chat/notify";
import { appendSessionMessages, type ChatUIMessage } from "@/lib/chat/sessions";
import {
  buildScheduledToolEvents,
  buildTerminalEvent,
  type TraceContext,
} from "@/lib/memory/capture";
import { appendDecisionOutcome, recordScheduledDecision } from "@/lib/memory/decisions";
import { isMemoryWriteEnabled } from "@/lib/memory/config";
import {
  appendTraceEventsFailOpen,
  type TraceEventInput,
} from "@/lib/memory/trace";
import { getBoss, stopBoss, TASK_QUEUE_NAME, taskSendOptions } from "@/lib/scheduler/boss";
import { recoverMissedRuns } from "@/lib/scheduler/catchup";
import { closePool } from "@/lib/scheduler/db";
import {
  buildToolCallMessages,
  clampChainDelaySeconds,
  executeScheduledTaskPayload,
  type InstructionTaskPayload,
} from "@/lib/scheduler/execute";
import {
  classifyInstructionVerdictAction,
  INSTRUCTION_PROMPT_HASH,
  type InstructionVerdict,
  type InstructionWorkerAction,
  requireInstructionRunnerEnv,
  runInstructionRound,
} from "@/lib/scheduler/instruction";
import {
  cancelScheduledTask,
  countConsecutiveFailedRuns,
  getLatestCompletedRunOutput,
  getScheduledTaskById,
  markRunCompleted,
  markRunFailed,
  markRunSkipped,
  markRunStarted,
  markTaskCancelled,
  markTaskCompleted,
  type ScheduledTask,
  setInstructionRound,
  updateTaskJobId,
} from "@/lib/scheduler/tasks";
import { enqueueCompletedScheduledAttempt } from "@/lib/self-improvement/enqueue";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

const INSTRUCTION_FAILURE_LIMIT = 3;
type TaskJobData = { taskId?: string };
type TaskJob = JobWithMetadata<TaskJobData>;
export type InstructionChainAction = InstructionWorkerAction;

function traceContext(job: TaskJob, task: ScheduledTask): TraceContext {
  return {
    agentId: DEFAULT_AGENT_ID,
    traceId: `${job.id}:attempt:${job.retryCount}`,
    sessionId: task.homeSessionId,
    taskId: task.id,
    pgBossJobId: job.id,
  };
}

async function processJob(job: TaskJob) {
  const taskId = job.data?.taskId;
  if (!taskId) throw new Error(`Job ${job.id} is missing a taskId.`);
  const task = await getScheduledTaskById(taskId);
  if (!task) {
    console.warn(`Job ${job.id} references missing task ${taskId}; skipping.`);
    return;
  }
  const context = traceContext(job, task);
  if (task.status !== "active") {
    await getDb().transaction(async (tx) => {
      await markRunSkipped(task.id, job.id, `Task was ${task.status} when the job ran.`, tx);
      if (isMemoryWriteEnabled()) {
        await appendTraceEventsFailOpen([buildTerminalEvent(context, "skipped")], tx);
      }
    });
    return;
  }
  if (task.payload.kind === "instruction") {
    await processInstructionJob(job, task, task.payload, context);
  } else {
    await processToolCallJob(job, task, context);
  }
}

async function processToolCallJob(job: TaskJob, task: ScheduledTask, context: TraceContext) {
  await markRunStarted(task.id, job.id);
  try {
    const output = await executeScheduledTaskPayload(task.payload as Extract<typeof task.payload, { kind: "tool_call" }>);
    await getDb().transaction(async (tx) => {
      await markRunCompleted(job.id, output, tx);
      if (isMemoryWriteEnabled() && task.payload.kind === "tool_call") {
        await appendTraceEventsFailOpen(
          [
            ...buildScheduledToolEvents(
              context,
              task.payload.toolName,
              task.payload.arguments,
              output,
            ),
            buildTerminalEvent(context, "completed"),
          ],
          tx,
        );
      }
    });
    if (task.scheduleType === "once") await markTaskCompleted(task.id);
    await appendWorkerMessages(task, buildToolCallMessages(task.id, job.id, output));
    await enqueueScheduledReview(job, task, context);
    console.log(`Completed run for task ${task.id} (job ${job.id}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getDb().transaction(async (tx) => {
      await markRunFailed(job.id, message, tx);
      if (isMemoryWriteEnabled() && task.payload.kind === "tool_call") {
        await appendTraceEventsFailOpen(
          [
            ...buildScheduledToolEvents(
              context,
              task.payload.toolName,
              task.payload.arguments,
              { error: message },
            ),
            buildTerminalEvent(context, "failed", { error: message }),
          ],
          tx,
        );
      }
    });
    console.error(`Run failed for task ${task.id} (job ${job.id}): ${message}`);
    throw error;
  }
}

async function processInstructionJob(
  job: TaskJob,
  task: ScheduledTask,
  payload: InstructionTaskPayload,
  context: TraceContext,
) {
  await markRunStarted(task.id, job.id);
  let verdict: InstructionVerdict | null = null;
  let messages: ChatUIMessage[] = [];
  let decisionId: string | null = null;
  const captured: TraceEventInput[] = [];

  try {
    const previousOutput = await getLatestCompletedRunOutput(task.id);
    const round = await runInstructionRound({
      task,
      payload,
      previousOutput,
      traceContext: context,
      onTraceEvents: (events) => captured.push(...events),
    });
    const currentVerdict = round.verdict;
    verdict = currentVerdict;
    messages = round.messages;
    const terminal = buildTerminalEvent(context, "completed");
    await getDb().transaction(async (tx) => {
      await markRunCompleted(job.id, { round: payload.round, ...currentVerdict }, tx);
      if (isMemoryWriteEnabled()) {
        const traceRows = await appendTraceEventsFailOpen(
          [...round.traceEvents, terminal],
          tx,
        );
        if (traceRows.length > 0) {
          try {
            const decision = await tx.transaction((savepoint) =>
              recordScheduledDecision(
                {
                  agentId: DEFAULT_AGENT_ID,
                  taskId: task.id,
                  sessionId: task.homeSessionId,
                  pgBossJobId: job.id,
                  traceId: context.traceId,
                  round: payload.round,
                  retryCount: job.retryCount,
                  selectedOption: currentVerdict.continue ? "continue_chain" : "stop_chain",
                  declaredOptions: ["continue_chain", "stop_chain"],
                  declaredRationale: currentVerdict.declaredRationale,
                  expectedOutcome: currentVerdict.expectedOutcome,
                  successCriteria: currentVerdict.successCriteria,
                  modelId: round.modelId,
                  promptHash: INSTRUCTION_PROMPT_HASH,
                },
                savepoint,
              ),
            );
            decisionId = decision.id;
          } catch (error) {
            console.error("Scheduled decision capture failed; run completion continues", error);
          }
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getDb().transaction(async (tx) => {
      await markRunFailed(job.id, message, tx);
      if (isMemoryWriteEnabled()) {
        await appendTraceEventsFailOpen(
          [...captured, buildTerminalEvent(context, "failed", { error: message })],
          tx,
        );
      }
    });
    console.error(`Instruction round ${payload.round} failed for task ${task.id}: ${message}`);
  }

  if (verdict) await appendWorkerMessages(task, messages);

  let action: InstructionChainAction = "chain_halted";
  let mutationError: unknown;
  try {
    action = await advanceInstructionChain(task, payload, verdict);
  } catch (error) {
    mutationError = error;
    console.error(`Chain mutation failed for task ${task.id}`, error);
  }

  if (decisionId && verdict) {
    const supports = !mutationError && action !== "chain_halted";
    await appendDecisionOutcome({
      agentId: DEFAULT_AGENT_ID,
      decisionId,
      taskId: task.id,
      pgBossJobId: job.id,
      traceId: context.traceId,
      round: payload.round,
      retryCount: job.retryCount,
      observedState: mutationError
        ? `Worker chain mutation failed: ${mutationError instanceof Error ? mutationError.message : String(mutationError)}`
        : `Worker action: ${action}`,
      assessment: mutationError ? "contradicts" : supports ? "supports" : "inconclusive",
      status: mutationError ? "failed" : supports ? "succeeded" : "unknown",
    }).catch((error) => console.error("Recording scheduled decision outcome failed", error));
  }

  if (verdict) await enqueueScheduledReview(job, task, context);
}

async function appendWorkerMessages(task: ScheduledTask, messages: ChatUIMessage[]) {
  if (!task.homeSessionId || messages.length === 0) return;
  try {
    await appendSessionMessages(task.homeSessionId, messages);
    await notifySessionAppended(task.homeSessionId);
  } catch (error) {
    console.error(`Appending scheduled output for task ${task.id} failed`, error);
  }
}

async function enqueueScheduledReview(job: TaskJob, task: ScheduledTask, context: TraceContext) {
  await enqueueCompletedScheduledAttempt({
    agentId: DEFAULT_AGENT_ID,
    taskId: task.id,
    pgBossJobId: job.id,
    attemptTraceId: context.traceId,
    reviewKey: `scheduled:${task.id}:${context.traceId}`,
  }).catch((error) => console.error("Enqueuing scheduled trace review failed", error));
}

export async function advanceInstructionChain(
  task: ScheduledTask,
  payload: InstructionTaskPayload,
  verdict: InstructionVerdict | null,
): Promise<InstructionChainAction> {
  const currentTask = await getScheduledTaskById(task.id);
  if (!currentTask || currentTask.status !== "active") {
    if (verdict) await setInstructionRound(task.id, payload.round + 1);
    return "chain_halted";
  }
  const reachedCap = payload.round >= payload.maxRounds;
  if (!verdict) {
    const failures = await countConsecutiveFailedRuns(task.id, INSTRUCTION_FAILURE_LIMIT);
    if (failures >= INSTRUCTION_FAILURE_LIMIT) {
      if (task.scheduleType === "cron") await cancelScheduledTask(task.id);
      else await markTaskCancelled(task.id);
      return "task_cancelled";
    }
    if (task.scheduleType === "cron") {
      await setInstructionRound(task.id, payload.round + 1);
      return "next_round_scheduled";
    }
    if (reachedCap) {
      await markTaskCompleted(task.id);
      return "task_completed";
    }
    await chainNextRound(task, payload, null);
    return "next_round_scheduled";
  }
  const action = classifyInstructionVerdictAction(task.scheduleType, payload, verdict);
  if (action === "next_round_scheduled") {
    if (task.scheduleType === "once") {
      await chainNextRound(task, payload, verdict.nextDelaySeconds);
    } else {
      await setInstructionRound(task.id, payload.round + 1);
    }
  } else if (action === "task_completed") {
    await markTaskCompleted(task.id);
  } else {
    await cancelScheduledTask(task.id);
  }
  return action;
}

async function chainNextRound(
  task: ScheduledTask,
  payload: InstructionTaskPayload,
  requestedDelaySeconds: number | null,
) {
  const delay = clampChainDelaySeconds(requestedDelaySeconds ?? payload.cadenceSeconds);
  await setInstructionRound(task.id, payload.round + 1);
  const boss = await getBoss();
  const jobId = await boss.sendAfter(
    TASK_QUEUE_NAME,
    { taskId: task.id },
    taskSendOptions(task.id),
    delay,
  );
  if (!jobId) throw new Error("pg-boss did not return a job id for the next chain round.");
  await updateTaskJobId(task.id, jobId);
}

async function main() {
  requireInstructionRunnerEnv();
  const boss = await getBoss();
  void recoverMissedRuns().catch((error) =>
    console.error("Missed-run catch-up failed; worker continues", error),
  );
  await boss.work<TaskJobData>(
    TASK_QUEUE_NAME,
    { pollingIntervalSeconds: 2, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs as JobWithMetadata<TaskJobData>[]) await processJob(job);
    },
  );
  console.log(`Scheduled-task worker listening on '${TASK_QUEUE_NAME}'.`);
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping worker...`);
  try {
    await stopBoss({ graceful: true });
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error("Worker shutdown failed", error);
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
main().catch((error) => {
  console.error("Worker failed to start", error);
  process.exit(1);
});
