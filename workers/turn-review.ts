import "@/lib/scheduler/load-env";

import type { Job } from "pg-boss";

import { getBoss, stopBoss, TURN_REVIEW_QUEUE_NAME } from "@/lib/scheduler/boss";
import { closePool } from "@/lib/scheduler/db";
import type { TurnReviewJobData } from "@/lib/self-improvement/enqueue";
import { runTurnReview } from "@/lib/self-improvement/review";

async function processJob(job: Job<TurnReviewJobData>) {
  const data = parseJobData(job.data);
  if (!data) {
    console.warn(`Turn-review job ${job.id} has invalid data; skipping.`);
    return;
  }
  if (data.kind === "scheduled") {
    // Typed trace distillation lands in the next commit. The write flag is dark
    // by default, so intermediate deployments do not enqueue this shape.
    console.warn(`Scheduled trace review ${data.reviewKey} deferred until typed distillation.`);
    return;
  }
  try {
    const result = await runTurnReview(data);
    console.log(
      `Reviewed session ${data.sessionId} through ${data.triggerMessageId}: ${result.proposalCount} proposal(s).`,
    );
  } catch (error) {
    console.error(`Turn-review job ${job.id} failed`, error);
  }
}

export function parseJobData(value: unknown): TurnReviewJobData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.agentId !== "string" || typeof data.reviewKey !== "string") return null;
  if (
    data.kind === "chat" &&
    typeof data.sessionId === "string" &&
    typeof data.triggerMessageId === "string" &&
    typeof data.latestTerminalTraceId === "string" &&
    (typeof data.reviewFrom === "string" || data.reviewFrom === null)
  ) {
    return {
      kind: "chat",
      agentId: data.agentId,
      sessionId: data.sessionId,
      triggerMessageId: data.triggerMessageId,
      latestTerminalTraceId: data.latestTerminalTraceId,
      reviewFrom: data.reviewFrom as string | null,
      reviewKey: data.reviewKey,
    };
  }
  if (
    data.kind === "scheduled" &&
    typeof data.taskId === "string" &&
    typeof data.pgBossJobId === "string" &&
    typeof data.attemptTraceId === "string"
  ) {
    return {
      kind: "scheduled",
      agentId: data.agentId,
      taskId: data.taskId,
      pgBossJobId: data.pgBossJobId,
      attemptTraceId: data.attemptTraceId,
      reviewKey: data.reviewKey,
    };
  }
  return null;
}

async function main() {
  const boss = await getBoss();
  await boss.work<TurnReviewJobData>(
    TURN_REVIEW_QUEUE_NAME,
    { pollingIntervalSeconds: 5 },
    async (jobs) => {
      for (const job of jobs) await processJob(job);
    },
  );
  console.log(`Turn-review worker listening on '${TURN_REVIEW_QUEUE_NAME}'.`);
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping turn-review worker...`);
  try {
    await stopBoss({ graceful: true });
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error("Turn-review worker shutdown failed", error);
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
main().catch((error) => {
  console.error("Turn-review worker failed to start", error);
  process.exit(1);
});
