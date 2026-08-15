import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { agentReviewStates } from "@/db/schema";
import { isMemoryWriteEnabled } from "@/lib/memory/config";
import { getBoss, TURN_REVIEW_QUEUE_NAME, turnReviewSendOptions } from "@/lib/scheduler/boss";
import {
  getMemoryReviewInterval,
  getTurnReviewDelaySeconds,
  isSelfImprovementEnabled,
} from "@/lib/self-improvement/config";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

export type ChatTurnReviewJobData = {
  kind: "chat";
  agentId: string;
  sessionId: string;
  triggerMessageId: string;
  latestTerminalTraceId: string;
  reviewFrom: string | null;
  reviewKey: string;
};

export type ScheduledTurnReviewJobData = {
  kind: "scheduled";
  agentId: string;
  taskId: string;
  pgBossJobId: string;
  attemptTraceId: string;
  reviewKey: string;
};

export type TurnReviewJobData = ChatTurnReviewJobData | ScheduledTurnReviewJobData;
export type TurnReviewEnqueueResult =
  | { enqueued: false; reason: "disabled" | "below-threshold" }
  | { enqueued: true; jobId: string };

export async function recordCompletedTurnAndMaybeEnqueueReview({
  agentId = DEFAULT_AGENT_ID,
  sessionId,
  triggerMessageId,
  latestTerminalTraceId,
  reviewKey,
}: {
  agentId?: string;
  sessionId: string;
  triggerMessageId: string;
  latestTerminalTraceId: string;
  reviewKey: string;
}): Promise<TurnReviewEnqueueResult> {
  if (!isSelfImprovementEnabled() || !isMemoryWriteEnabled()) {
    return { enqueued: false, reason: "disabled" };
  }

  const state = await incrementReviewCounter({ agentId, sessionId });
  if (state.turnsSinceMemoryReview < getMemoryReviewInterval()) {
    return { enqueued: false, reason: "below-threshold" };
  }

  const data: ChatTurnReviewJobData = {
    kind: "chat",
    agentId,
    sessionId,
    triggerMessageId,
    latestTerminalTraceId,
    reviewFrom: state.lastReviewedAt?.toISOString() ?? null,
    reviewKey,
  };
  const boss = await getBoss();
  const jobId = await boss.sendAfter(
    TURN_REVIEW_QUEUE_NAME,
    data,
    turnReviewSendOptions(sessionId),
    getTurnReviewDelaySeconds(),
  );
  if (!jobId) throw new Error("pg-boss did not return a job id for turn review.");
  // Queueing resets cadence only. The successful-review watermark advances in
  // the worker's candidate/admission transaction, never at enqueue time.
  await resetReviewCadenceAfterEnqueue({ agentId, sessionId });
  return { enqueued: true, jobId };
}

export async function enqueueCompletedScheduledAttempt(
  data: Omit<ScheduledTurnReviewJobData, "kind">,
): Promise<TurnReviewEnqueueResult> {
  if (!isSelfImprovementEnabled() || !isMemoryWriteEnabled()) {
    return { enqueued: false, reason: "disabled" };
  }
  const boss = await getBoss();
  const jobId = await boss.send(
    TURN_REVIEW_QUEUE_NAME,
    { kind: "scheduled", ...data } satisfies ScheduledTurnReviewJobData,
    turnReviewSendOptions(`scheduled:${data.taskId}:${data.pgBossJobId}`),
  );
  if (!jobId) throw new Error("pg-boss did not return a job id for scheduled turn review.");
  return { enqueued: true, jobId };
}

async function incrementReviewCounter(input: { agentId: string; sessionId: string }) {
  return getDb().transaction(async (tx) => {
    await tx
      .insert(agentReviewStates)
      .values({ agentId: input.agentId, sessionId: input.sessionId })
      .onConflictDoNothing();
    const [before] = await tx
      .select()
      .from(agentReviewStates)
      .where(
        and(
          eq(agentReviewStates.agentId, input.agentId),
          eq(agentReviewStates.sessionId, input.sessionId),
        ),
      )
      .for("update");
    const [after] = await tx
      .update(agentReviewStates)
      .set({
        turnsSinceMemoryReview: sql`${agentReviewStates.turnsSinceMemoryReview} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(agentReviewStates.agentId, input.agentId),
          eq(agentReviewStates.sessionId, input.sessionId),
        ),
      )
      .returning({ turnsSinceMemoryReview: agentReviewStates.turnsSinceMemoryReview });
    return {
      turnsSinceMemoryReview: after?.turnsSinceMemoryReview ?? 1,
      lastReviewedAt: before?.lastReviewedAt ?? null,
    };
  });
}

export async function resetReviewCadenceAfterEnqueue(input: {
  agentId: string;
  sessionId: string;
}) {
  await getDb()
    .update(agentReviewStates)
    .set({
      turnsSinceMemoryReview: 0,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentReviewStates.agentId, input.agentId),
        eq(agentReviewStates.sessionId, input.sessionId),
      ),
    );
}
