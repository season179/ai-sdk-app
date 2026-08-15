import { sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import { recordMemoryEvent } from "@/lib/consolidation/events";
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
  parseMemorySource,
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

  const proposal: ReviewProposal = applied;

  // Fire the applied event for the timeline (§3d). Fail-soft: recordMemoryEvent
  // swallows its own errors so a logging miss never breaks the apply path.
  await recordMemoryEvent({
    eventType: "applied",
    origin: eventOriginFor(proposal.proposerOrigin),
    summary: `Applied ${proposal.kind} proposal (${proposal.proposerOrigin}).`,
    proposalId: proposal.id,
    detail: {
      version: 1,
      admissionMetadata: proposal.admissionMetadata ?? undefined,
    },
  });

  return proposal;
}

/** Map a proposal's proposerOrigin onto a MemoryEventOrigin. */
function eventOriginFor(
  origin: ReviewProposal["proposerOrigin"],
): "user" | "review" | "consolidation" | "curator" {
  switch (origin) {
    case "manual":
      return "user";
    case "turn_review":
      return "review";
    case "consolidation":
      return "consolidation";
    case "curator":
      return "curator";
  }
}

async function applyPendingProposal(proposal: ReviewProposal, db: AppDbClient): Promise<void> {
  const payload = readPayloadObject(proposal.payload);

  switch (proposal.kind) {
    case "memory_create": {
      if (await getMemoryByReviewProposalId(proposal.id, proposal.agentId, db)) {
        return;
      }

      // Derive the memory source from the proposal and guard the privileged
      // `consolidated` source (§1.1): only consolidation proposals may mint a
      // consolidated memory. Everything else lands as `review`.
      const memorySource =
        proposal.proposerOrigin === "consolidation"
          ? parseMemorySource(payload.source, "consolidated")
          : parseMemorySource(payload.source, "review");

      if (memorySource === "consolidated" && proposal.proposerOrigin !== "consolidation") {
        throw new SelfImprovementInputError(
          "Only consolidation proposals may create consolidated memories.",
        );
      }

      // Consolidation proposals carry a claim_hash in admission_metadata; stamp
      // it on the memory so the agent_memories_claim_hash_uniq partial unique
      // index makes auto-apply races safe (§4.4).
      const claimHash = proposal.admissionMetadata?.claimHash ?? null;

      try {
        // Isolate a uniqueness race in a savepoint. PostgreSQL marks the
        // current transaction failed after a constraint violation; without the
        // nested transaction the no-op path could not mark the proposal applied.
        await db.transaction(async (savepoint) =>
          createMemory(
            {
              agentId: proposal.agentId,
              kind: parseMemoryKind(payload.memoryKind ?? payload.kind),
              content: parseMemoryContent(payload.content),
              confidence: parseMemoryConfidence(payload.confidence),
              source: memorySource,
              sessionId: proposal.sessionId,
              reviewProposalId: proposal.id,
              claimHash,
            },
            savepoint,
          ),
        );
      } catch (error) {
        // §4.4 race safety: a duplicate-key on agent_memories_claim_hash_uniq
        // means a concurrent writer already minted this durable fact. Treat as
        // already-applied / no-op and log duplicate_claim_hash. This keeps
        // auto-apply additive-only and idempotent.
        if (isDuplicateClaimHashError(error)) {
          await recordMemoryEvent({
            eventType: "applied",
            origin: eventOriginFor(proposal.proposerOrigin),
            summary: `Apply no-op: duplicate claim_hash for proposal ${proposal.id}.`,
            proposalId: proposal.id,
            detail: {
              version: 1,
              admissionMetadata: proposal.admissionMetadata ?? undefined,
              reason: "duplicate_claim_hash",
            },
          }).catch(() => undefined);
          return;
        }
        throw error;
      }
      return;
    }

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

/**
 * Detect a Postgres unique-violation on agent_memories_claim_hash_uniq (§4.4
 * race safety). pg error code 23505 with the constraint name; some drivers
 * surface it only in the message string. Used by the memory_create branch to
 * treat a duplicate as already-applied / no-op.
 */
export function isDuplicateClaimHashError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const e = current as {
      code?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      (e.code === "23505" && e.constraint?.includes("claim_hash")) ||
      e.message?.includes("agent_memories_claim_hash_uniq") ||
      e.message?.includes("claim_hash_uniq")
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}
