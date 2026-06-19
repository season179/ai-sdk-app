import { and, desc, eq, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  type AgentReviewProposal,
  agentReviewProposals,
  type NewAgentReviewProposal,
  type ReviewProposalKind,
  type ReviewProposalPayload,
  type ReviewProposalStatus,
} from "@/db/schema";
import {
  ReviewProposalNotFoundError,
  SelfImprovementInputError,
} from "@/lib/self-improvement/errors";
import {
  parseRationale,
  parseReviewProposalKind,
  readPayloadObject,
} from "@/lib/self-improvement/validation";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

export type ReviewProposal = {
  id: string;
  agentId: string;
  sessionId: string | null;
  triggerMessageId: string | null;
  kind: ReviewProposalKind;
  payload: ReviewProposalPayload;
  rationale: string;
  status: ReviewProposalStatus;
  reviewerModel: string | null;
  appliedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateReviewProposalInput = {
  kind: unknown;
  payload: unknown;
  rationale: unknown;
  sessionId?: string | null;
  triggerMessageId?: string | null;
  reviewerModel?: string | null;
  agentId?: string;
};

export async function listReviewProposals({
  agentId = DEFAULT_AGENT_ID,
  status,
}: {
  agentId?: string;
  status?: ReviewProposalStatus;
} = {}): Promise<ReviewProposal[]> {
  const conditions = [eq(agentReviewProposals.agentId, agentId)];

  if (status) {
    conditions.push(eq(agentReviewProposals.status, status));
  }

  const rows = await getDb()
    .select()
    .from(agentReviewProposals)
    .where(and(...conditions))
    .orderBy(desc(agentReviewProposals.createdAt))
    .limit(200);

  return rows.map(mapProposalRow);
}

export async function getReviewProposalById(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<ReviewProposal | null> {
  const rows = await db
    .select()
    .from(agentReviewProposals)
    .where(and(eq(agentReviewProposals.id, id), eq(agentReviewProposals.agentId, agentId)));

  return rows[0] ? mapProposalRow(rows[0]) : null;
}

export async function createReviewProposal(
  input: CreateReviewProposalInput,
  db: AppDbClient = getDb(),
): Promise<ReviewProposal> {
  const value: NewAgentReviewProposal = {
    agentId: input.agentId ?? DEFAULT_AGENT_ID,
    sessionId: input.sessionId ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    kind: parseReviewProposalKind(input.kind),
    payload: readPayloadObject(input.payload),
    rationale: parseRationale(input.rationale),
    reviewerModel: input.reviewerModel ?? null,
  };

  const inserted = await db.insert(agentReviewProposals).values(value).returning();
  return mapProposalRow(inserted[0]);
}

export async function rejectReviewProposal(id: string): Promise<ReviewProposal> {
  const proposal = await requireProposal(id);

  if (proposal.status !== "pending") {
    throw new SelfImprovementInputError("Only pending proposals can be rejected.");
  }

  return setProposalStatus(id, { status: "rejected", error: null });
}

export async function markProposalApplied(
  id: string,
  db: AppDbClient = getDb(),
): Promise<ReviewProposal> {
  return setProposalStatus(
    id,
    { status: "applied", appliedAt: sql`now()`, error: null },
    db,
    "pending",
  );
}

export async function markProposalFailed(
  id: string,
  error: string,
  db: AppDbClient = getDb(),
): Promise<ReviewProposal> {
  return setProposalStatus(id, { status: "failed", error }, db, "pending");
}

export async function requireProposal(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
): Promise<ReviewProposal> {
  const proposal = await getReviewProposalById(id, agentId, db);

  if (!proposal) {
    throw new ReviewProposalNotFoundError(id);
  }

  return proposal;
}

async function setProposalStatus(
  id: string,
  values: {
    status: ReviewProposalStatus;
    appliedAt?: ReturnType<typeof sql>;
    error?: string | null;
  },
  db: AppDbClient = getDb(),
  expectedStatus?: ReviewProposalStatus,
): Promise<ReviewProposal> {
  const conditions = [eq(agentReviewProposals.id, id)];

  if (expectedStatus) {
    conditions.push(eq(agentReviewProposals.status, expectedStatus));
  }

  const rows = await db
    .update(agentReviewProposals)
    .set({
      status: values.status,
      appliedAt: values.appliedAt,
      error: values.error,
      updatedAt: sql`now()`,
    })
    .where(and(...conditions))
    .returning();

  if (!rows[0]) {
    throw new ReviewProposalNotFoundError(id);
  }

  return mapProposalRow(rows[0]);
}

function mapProposalRow(row: AgentReviewProposal): ReviewProposal {
  return {
    id: row.id,
    agentId: row.agentId,
    sessionId: row.sessionId,
    triggerMessageId: row.triggerMessageId,
    kind: row.kind,
    payload: row.payload,
    rationale: row.rationale,
    status: row.status,
    reviewerModel: row.reviewerModel,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
