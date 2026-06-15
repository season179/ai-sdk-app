import "@/lib/scheduler/load-env";

import type { Job } from "pg-boss";

import { getBoss, stopBoss, TASK_QUEUE_NAME, taskSendOptions } from "@/lib/scheduler/boss";
import { recoverMissedRuns } from "@/lib/scheduler/catchup";
import { closePool } from "@/lib/scheduler/db";
import {
  clampChainDelaySeconds,
  executeScheduledTaskPayload,
  type InstructionTaskPayload,
} from "@/lib/scheduler/execute";
import {
  type InstructionVerdict,
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

/** Consecutive failed rounds after which an instruction chain is abandoned. */
const INSTRUCTION_FAILURE_LIMIT = 3;

type TaskJobData = {
  taskId?: string;
};

async function processJob(job: Job<TaskJobData>) {
  const taskId = job.data?.taskId;

  if (!taskId) {
    throw new Error(`Job ${job.id} is missing a taskId.`);
  }

  const task = await getScheduledTaskById(taskId);

  if (!task) {
    console.warn(`Job ${job.id} references missing task ${taskId}; skipping.`);
    return;
  }

  if (task.status !== "active") {
    await markRunSkipped(task.id, job.id, `Task was ${task.status} when the job ran.`);
    console.log(`Skipped run for ${task.status} task ${task.id} (job ${job.id}).`);
    return;
  }

  if (task.payload.kind === "instruction") {
    await processInstructionJob(job, task, task.payload);
    return;
  }

  await markRunStarted(task.id, job.id);

  try {
    const output = await executeScheduledTaskPayload(task.payload);
    await markRunCompleted(job.id, output);

    if (task.scheduleType === "once") {
      await markTaskCompleted(task.id);
    }

    console.log(`Completed run for task ${task.id} (job ${job.id}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markRunFailed(job.id, message);
    console.error(`Run failed for task ${task.id} (job ${job.id}): ${message}`);
    // Rethrow so pg-boss applies retry and dead-letter policy.
    throw error;
  }
}

/**
 * Instruction runs never rethrow: a pg-boss retry would re-run the round and
 * double-judge the chain. A failure consumes its round, the chain stays alive
 * through transient outages, and a consecutive-failure limit stops hopeless
 * chains. The model only judges via the verdict; every schedule mutation
 * below is deterministic worker code.
 */
async function processInstructionJob(
  job: Job<TaskJobData>,
  task: ScheduledTask,
  payload: InstructionTaskPayload,
) {
  await markRunStarted(task.id, job.id);

  let verdict: InstructionVerdict | null = null;

  try {
    const previousOutput = await getLatestCompletedRunOutput(task.id);
    verdict = await runInstructionRound({ task, payload, previousOutput });
    await markRunCompleted(job.id, { round: payload.round, ...verdict });
    console.log(
      `Instruction round ${payload.round}/${payload.maxRounds} completed for task ${task.id} (job ${job.id}).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markRunFailed(job.id, message);
    console.error(
      `Instruction round ${payload.round} failed for task ${task.id} (job ${job.id}): ${message}`,
    );
  }

  try {
    await advanceInstructionChain(task, payload, verdict);
  } catch (error) {
    console.error(
      `Chain mutation failed for task ${task.id}; startup catch-up restores liveness`,
      error,
    );
  }
}

async function advanceInstructionChain(
  task: ScheduledTask,
  payload: InstructionTaskPayload,
  verdict: InstructionVerdict | null,
) {
  const reachedCap = payload.round >= payload.maxRounds;

  if (!verdict) {
    const failures = await countConsecutiveFailedRuns(task.id, INSTRUCTION_FAILURE_LIMIT);

    if (failures >= INSTRUCTION_FAILURE_LIMIT) {
      if (task.scheduleType === "cron") {
        await cancelScheduledTask(task.id);
      } else {
        await markTaskCancelled(task.id);
      }

      console.error(
        `Instruction chain for task ${task.id} stopped after ${failures} consecutive failures.`,
      );
    } else if (task.scheduleType === "cron") {
      await setInstructionRound(task.id, payload.round + 1);
    } else if (reachedCap) {
      await markTaskCompleted(task.id);
    } else {
      await chainNextRound(task, payload, null);
    }

    return;
  }

  const shouldContinue = verdict.continue && !reachedCap;
  const stopReason = verdict.continue ? "max rounds reached" : "agent stopped";

  if (task.scheduleType === "once") {
    if (shouldContinue) {
      await chainNextRound(task, payload, verdict.nextDelaySeconds);
    } else {
      await markTaskCompleted(task.id);
      console.log(
        `Instruction chain for task ${task.id} finished after round ${payload.round} (${stopReason}).`,
      );
    }
  } else if (shouldContinue) {
    await setInstructionRound(task.id, payload.round + 1);
  } else {
    await cancelScheduledTask(task.id);
    console.log(
      `Recurring instruction task ${task.id} cancelled after round ${payload.round} (${stopReason}).`,
    );
  }
}

async function chainNextRound(
  task: ScheduledTask,
  payload: InstructionTaskPayload,
  requestedDelaySeconds: number | null,
) {
  const delaySeconds = clampChainDelaySeconds(requestedDelaySeconds ?? payload.cadenceSeconds);

  // Advance the round before sending so a crash between the two steps can
  // only skip a round number, never replay one.
  await setInstructionRound(task.id, payload.round + 1);

  const boss = await getBoss();
  // The prior job completed, so the stately singleton slot for this key is
  // free; a keyless send here would collide queue-wide instead.
  const jobId = await boss.sendAfter(
    TASK_QUEUE_NAME,
    { taskId: task.id },
    taskSendOptions(task.id),
    delaySeconds,
  );

  if (!jobId) {
    throw new Error("pg-boss did not return a job id for the next chain round.");
  }

  await updateTaskJobId(task.id, jobId);
  console.log(
    `Task ${task.id}: round ${payload.round + 1}/${payload.maxRounds} scheduled in ${delaySeconds}s (job ${jobId}).`,
  );
}

async function main() {
  // Instruction payloads run an agent loop, so the worker needs OpenRouter
  // env in addition to DATABASE_URL. Same standard as the chat route: fail
  // at startup with a clear message, not at the first fire.
  requireInstructionRunnerEnv();

  const boss = await getBoss();

  // Catch-up is best-effort: run it alongside the worker so a bad task row
  // or a flaky database can never block or crashloop job consumption.
  void recoverMissedRuns()
    .then(({ cronRuns, chainRuns }) => {
      if (cronRuns > 0) {
        console.log(`Queued ${cronRuns} catch-up run(s) for cron fires missed while down.`);
      }

      if (chainRuns > 0) {
        console.log(`Queued ${chainRuns} job(s) to revive broken instruction chains.`);
      }
    })
    .catch((error) => {
      console.error("Missed-run catch-up failed; worker continues without it", error);
    });

  await boss.work<TaskJobData>(TASK_QUEUE_NAME, { pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) {
      await processJob(job);
    }
  });

  console.log(`Scheduled-task worker listening on '${TASK_QUEUE_NAME}'.`);
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }

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
