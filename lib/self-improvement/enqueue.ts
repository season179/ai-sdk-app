import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { agentReviewStates } from "@/db/schema";
import { getBoss, TURN_REVIEW_QUEUE_NAME, turnReviewSendOptions } from "@/lib/scheduler/boss";
import {
  getMemoryReviewInterval,
  getTurnReviewDelaySeconds,
  isSelfImprovementEnabled,
} from "@/lib/self-improvement/config";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

export type TurnReviewJobData = {
  agentId: string;
  sessionId: string;
  triggerMessageId: string;
};

export type TurnReviewEnqueueResult =
  | { enqueued: false; reason: "disabled" | "below-threshold" }
  | { enqueued: true; jobId: string };

export async function recordCompletedTurnAndMaybeEnqueueReview({
  agentId = DEFAULT_AGENT_ID,
  sessionId,
  triggerMessageId,
}: {
  agentId?: string;
  sessionId: string;
  triggerMessageId: string;
}): Promise<TurnReviewEnqueueResult> {
  if (!isSelfImprovementEnabled()) {
    return { enqueued: false, reason: "disabled" };
  }

  const interval = getMemoryReviewInterval();
  const turnsSinceMemoryReview = await incrementReviewCounter({ agentId, sessionId });

  if (turnsSinceMemoryReview < interval) {
    return { enqueued: false, reason: "below-threshold" };
  }

  const boss = await getBoss();
  const jobId = await boss.sendAfter(
    TURN_REVIEW_QUEUE_NAME,
    { agentId, sessionId, triggerMessageId } satisfies TurnReviewJobData,
    turnReviewSendOptions(sessionId),
    getTurnReviewDelaySeconds(),
  );

  if (!jobId) {
    throw new Error("pg-boss did not return a job id for turn review.");
  }

  await resetReviewCounter({ agentId, sessionId, triggerMessageId });
  return { enqueued: true, jobId };
}

async function incrementReviewCounter({
  agentId,
  sessionId,
}: {
  agentId: string;
  sessionId: string;
}) {
  const rows = await getDb()
    .insert(agentReviewStates)
    .values({ agentId, sessionId, turnsSinceMemoryReview: 1 })
    .onConflictDoUpdate({
      target: [agentReviewStates.agentId, agentReviewStates.sessionId],
      set: {
        turnsSinceMemoryReview: sql`${agentReviewStates.turnsSinceMemoryReview} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ turnsSinceMemoryReview: agentReviewStates.turnsSinceMemoryReview });

  return rows[0]?.turnsSinceMemoryReview ?? 1;
}

async function resetReviewCounter({
  agentId,
  sessionId,
  triggerMessageId,
}: {
  agentId: string;
  sessionId: string;
  triggerMessageId: string;
}) {
  await getDb()
    .update(agentReviewStates)
    .set({
      turnsSinceMemoryReview: 0,
      lastReviewedMessageId: triggerMessageId,
      lastReviewedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(agentReviewStates.agentId, agentId), eq(agentReviewStates.sessionId, sessionId)));
}
