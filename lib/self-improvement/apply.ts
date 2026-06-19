import { sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import { SelfImprovementInputError } from "@/lib/self-improvement/errors";
import {
  archiveMemory,
  createMemory,
  getMemoryByReviewProposalId,
  updateMemory,
} from "@/lib/self-improvement/memories";
import {
  markProposalApplied,
  markProposalFailed,
  type ReviewProposal,
  requireProposal,
} from "@/lib/self-improvement/proposals";
import {
  parseMemoryConfidence,
  parseMemoryContent,
  parseMemoryKind,
  readOptionalString,
  readPayloadObject,
  readRequiredString,
} from "@/lib/self-improvement/validation";
import type { SkillReferenceInput } from "@/lib/skills/skills";
import { createSkill, updateSkill } from "@/lib/skills/skills";

export async function applyReviewProposal(id: string): Promise<ReviewProposal> {
  let applied: ReviewProposal | null = null;
  let shouldMarkFailed = false;

  try {
    await getDb().transaction(async (tx) => {
      // Serialize approval retries/double-clicks without introducing a durable
      // "applying" state; side effects and the status write share this transaction.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);

      const proposal = await requireProposal(id, undefined, tx);

      if (proposal.status !== "pending") {
        throw new SelfImprovementInputError("Only pending proposals can be applied.");
      }

      shouldMarkFailed = true;
      await applyPendingProposal(proposal, tx);
      applied = await markProposalApplied(id, tx);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (shouldMarkFailed) {
      await markProposalFailed(id, message).catch(() => undefined);
    }
    throw error;
  }

  if (!applied) {
    throw new Error("Review proposal apply completed without returning an updated proposal.");
  }

  return applied;
}

async function applyPendingProposal(proposal: ReviewProposal, db: AppDbClient): Promise<void> {
  const payload = readPayloadObject(proposal.payload);

  switch (proposal.kind) {
    case "memory_create":
      if (await getMemoryByReviewProposalId(proposal.id, proposal.agentId, db)) {
        return;
      }

      await createMemory(
        {
          agentId: proposal.agentId,
          kind: parseMemoryKind(payload.memoryKind ?? payload.kind),
          content: parseMemoryContent(payload.content),
          confidence: parseMemoryConfidence(payload.confidence),
          source: "review",
          sessionId: proposal.sessionId,
          reviewProposalId: proposal.id,
        },
        db,
      );
      return;

    case "memory_edit":
      await updateMemory(
        readRequiredString(payload, "memoryId"),
        {
          kind: payload.memoryKind ?? payload.kind,
          content: payload.content,
          confidence: payload.confidence,
        },
        proposal.agentId,
        db,
      );
      return;

    case "memory_archive":
      await archiveMemory(readRequiredString(payload, "memoryId"), proposal.agentId, db);
      return;

    case "skill_create":
      await createSkill(
        {
          name: readRequiredString(payload, "name"),
          description: readRequiredString(payload, "description"),
          body: readRequiredString(payload, "body"),
          references: readReferences(payload.references),
        },
        db,
      );
      return;

    case "skill_edit":
      await updateSkill(
        readRequiredString(payload, "skillId"),
        {
          name: readOptionalString(payload, "name"),
          description: readOptionalString(payload, "description"),
          body: readOptionalString(payload, "body"),
          isEnabled: readOptionalBoolean(payload, "isEnabled"),
          references: readReferences(payload.references),
        },
        db,
      );
      return;

    case "skill_toggle":
      await updateSkill(
        readRequiredString(payload, "skillId"),
        {
          isEnabled: readRequiredBoolean(payload, "isEnabled"),
        },
        db,
      );
      return;
  }
}

function readReferences(value: unknown): SkillReferenceInput[] | undefined {
  if (value == null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new SelfImprovementInputError("references must be an array.");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SelfImprovementInputError(`references[${index}] must be an object.`);
    }

    const reference = item as Record<string, unknown>;
    return {
      id: readOptionalString(reference, "id"),
      name: readRequiredString(reference, "name"),
      description: readRequiredString(reference, "description"),
      body: readRequiredString(reference, "body"),
    };
  });
}

function readOptionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];

  if (value == null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new SelfImprovementInputError(`Proposal payload field '${key}' must be a boolean.`);
  }

  return value;
}

function readRequiredBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = readOptionalBoolean(payload, key);

  if (value == null) {
    throw new SelfImprovementInputError(`Proposal payload field '${key}' is required.`);
  }

  return value;
}
