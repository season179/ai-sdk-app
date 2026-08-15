import { and, eq, inArray, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  agentGroundedObservations,
  agentMemories,
  agentMemoryCandidates,
  agentMemoryCandidateTraceEvents,
} from "@/db/schema";
import { recordMemoryEvent } from "@/lib/consolidation/events";
import { getMemoryPolicyVersion } from "@/lib/memory/config";
import { sanitizeTracePayload } from "@/lib/memory/redaction";
import {
  appendTraceEvents,
  assertCompletedTraceWindow,
  assertPromotableTraceEvidence,
} from "@/lib/memory/trace";
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
  parseMemoryType,
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

      const proposal = await requireProposal(id, null, tx);

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
      const sourceEventIds = await resolveProposalEvidence(proposal, payload, db);
      const proposedOperation = readCandidateOperation(payload, "ADD");
      if (proposedOperation !== "ADD") {
        throw new SelfImprovementInputError("operation_kind_mismatch");
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
      const claimHash =
        proposal.admissionMetadata?.version === 1
          ? (proposal.admissionMetadata.claimHash ?? null)
          : null;

      try {
        await assertCanonicalAddAvailable(proposal, payload, db);
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
              memoryType: payload.memoryType,
              canonicalKey: typeof payload.canonicalKey === "string" ? payload.canonicalKey : null,
              validFrom: payload.validFrom,
              validTo: payload.validTo,
              structured: readStructured(payload.structured),
              sourceReferenceTime: readOptionalDate(payload.sourceReferenceTime),
              timePrecision: readTimePrecision(payload.timePrecision),
              sensitivityClass: readSensitivity(payload.sensitivityClass),
              sourceEventIds,
              authority: memorySource === "consolidated" ? "consolidated" : "reviewed",
              extractorId: proposal.admissionMetadata?.version === 2 ? "turn-review-v1" : null,
              modelId: proposal.reviewerModel,
              promptHash: null,
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

    case "memory_edit": {
      const sourceEventIds = await resolveProposalEvidence(proposal, payload, db);
      if (readCandidateOperation(payload, "UPDATE") !== "UPDATE") {
        throw new SelfImprovementInputError("operation_kind_mismatch");
      }
      const target = await resolveCanonicalTarget(proposal, payload, db);
      if (target.conflictPolicy === "add_only") {
        throw new SelfImprovementInputError("conflict_policy_add_only");
      }
      await updateMemory(
        target.id,
        {
          kind: payload.memoryKind ?? payload.kind,
          content: payload.content,
          confidence: payload.confidence,
          memoryType: payload.memoryType,
          validFrom: payload.validFrom,
          validTo: payload.validTo,
          structured: readStructured(payload.structured),
          sourceReferenceTime: readOptionalDate(payload.sourceReferenceTime),
          timePrecision: readTimePrecision(payload.timePrecision),
          sensitivityClass: readSensitivity(payload.sensitivityClass),
          source: proposal.proposerOrigin === "consolidation" ? "consolidated" : "review",
          sourceEventIds,
          authority: "reviewed",
        },
        proposal.agentId,
        db,
      );
      return;
    }

    case "memory_archive": {
      const sourceEventIds = await resolveProposalEvidence(proposal, payload, db);
      if (readCandidateOperation(payload, "INVALIDATE") !== "INVALIDATE") {
        throw new SelfImprovementInputError("operation_kind_mismatch");
      }
      const target = await resolveCanonicalTarget(proposal, payload, db, true);
      if (target.status === "archived" || target.tombstoned) return;
      await archiveMemory(target.id, proposal.agentId, db, sourceEventIds);
      return;
    }

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

async function resolveProposalEvidence(
  proposal: ReviewProposal,
  payload: Record<string, unknown>,
  db: AppDbClient,
): Promise<string[]> {
  if (proposal.sourceCandidateId) {
    const rows = await db
      .select({
        eventId: agentMemoryCandidateTraceEvents.eventId,
        traceId: agentMemoryCandidates.traceId,
      })
      .from(agentMemoryCandidateTraceEvents)
      .innerJoin(
        agentMemoryCandidates,
        eq(agentMemoryCandidates.id, agentMemoryCandidateTraceEvents.candidateId),
      )
      .where(
        and(
          eq(agentMemoryCandidateTraceEvents.candidateId, proposal.sourceCandidateId),
          eq(agentMemoryCandidates.agentId, proposal.agentId),
          eq(agentMemoryCandidates.gateStatus, "accepted"),
        ),
      );
    if (rows.length === 0) throw new SelfImprovementInputError("Typed proposal has no evidence.");
    await assertCompletedTraceWindow(
      {
        agentId: proposal.agentId,
        eventIds: rows.map((row) => row.eventId),
        traceIds: [...new Set(rows.map((row) => row.traceId))],
      },
      db,
    );
    return rows.map((row) => row.eventId);
  }

  const observationIds =
    proposal.admissionMetadata?.version === 1
      ? (proposal.admissionMetadata.groundedObservationIds ?? [])
      : [];
  if (observationIds.length > 0) {
    const observations = await db
      .select({ traceEventId: agentGroundedObservations.traceEventId })
      .from(agentGroundedObservations)
      .where(
        and(
          eq(agentGroundedObservations.agentId, proposal.agentId),
          inArray(agentGroundedObservations.id, observationIds),
        ),
      );
    const eventIds = observations.flatMap((row) => (row.traceEventId ? [row.traceEventId] : []));
    if (eventIds.length !== observationIds.length) {
      throw new SelfImprovementInputError("Consolidation proposal has incomplete trace evidence.");
    }
    try {
      await assertPromotableTraceEvidence({ agentId: proposal.agentId, eventIds }, db);
    } catch {
      throw new SelfImprovementInputError(
        "Consolidation proposal evidence is not from a completed attempt.",
      );
    }
    return eventIds;
  }

  if (proposal.proposerOrigin !== "manual") {
    throw new SelfImprovementInputError("Memory proposal has no trace evidence.");
  }
  const sanitized = sanitizeTracePayload({
    proposalId: proposal.id,
    memoryKind: payload.memoryKind ?? payload.kind,
    content: payload.content,
  });
  const [event] = await appendTraceEvents(
    [
      {
        agentId: proposal.agentId,
        traceId: `manual-proposal:${proposal.id}`,
        sequenceNo: 0,
        sessionId: proposal.sessionId,
        eventType: "explicit_memory_write",
        actor: "user",
        trustClass: "user_assertion",
        payload: sanitized.payload,
        contentHash: sanitized.contentHash,
        idempotencyKey: `manual-proposal:${proposal.id}:explicit-memory-write`,
        retentionClass: "audit",
        policyVersion: getMemoryPolicyVersion(),
        occurredAt: new Date(),
      },
    ],
    db,
  );
  return [event.id];
}

type CandidateOperation = "ADD" | "UPDATE" | "INVALIDATE";

function readCandidateOperation(
  payload: Record<string, unknown>,
  fallback: CandidateOperation,
): CandidateOperation {
  const value = payload.proposedOperation ?? fallback;
  if (value === "ADD" || value === "UPDATE" || value === "INVALIDATE") return value;
  throw new SelfImprovementInputError("unsupported_candidate_operation");
}

function readStructured(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readOptionalDate(value: unknown): Date | null | undefined {
  if (value == null) return value === null ? null : undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SelfImprovementInputError("source_reference_time_invalid");
  }
  return new Date(value);
}

function readTimePrecision(
  value: unknown,
): "instant" | "day" | "month" | "year" | "unknown" | undefined {
  return ["instant", "day", "month", "year", "unknown"].includes(String(value))
    ? (value as "instant" | "day" | "month" | "year" | "unknown")
    : undefined;
}

function readSensitivity(value: unknown): "normal" | "sensitive" | "restricted" | undefined {
  return ["normal", "sensitive", "restricted"].includes(String(value))
    ? (value as "normal" | "sensitive" | "restricted")
    : undefined;
}

async function assertCanonicalAddAvailable(
  proposal: ReviewProposal,
  payload: Record<string, unknown>,
  db: AppDbClient,
): Promise<void> {
  const canonicalKey = typeof payload.canonicalKey === "string" ? payload.canonicalKey.trim() : "";
  if (!canonicalKey) return;
  const kind = parseMemoryKind(payload.memoryKind ?? payload.kind);
  const memoryType = parseMemoryType(
    payload.memoryType,
    kind === "episode" ? "episodic" : kind === "procedure" ? "procedural" : "semantic",
  );
  const scopeType = proposal.sessionId ? "session" : "agent";
  const scopeId = proposal.sessionId ?? proposal.agentId;
  const lockKey = `${proposal.agentId}:${scopeType}:${scopeId}:${memoryType}:${canonicalKey}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
  const [existing] = await db
    .select({ id: agentMemories.id })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, proposal.agentId),
        eq(agentMemories.scopeType, scopeType),
        eq(agentMemories.scopeId, scopeId),
        eq(agentMemories.memoryType, memoryType),
        eq(agentMemories.canonicalKey, canonicalKey),
        eq(agentMemories.status, "approved"),
        eq(agentMemories.tombstoned, false),
      ),
    )
    .limit(1);
  if (existing) throw new SelfImprovementInputError("canonical_key_exists");
}

async function resolveCanonicalTarget(
  proposal: ReviewProposal,
  payload: Record<string, unknown>,
  db: AppDbClient,
  allowArchived = false,
) {
  const memoryId = typeof payload.memoryId === "string" ? payload.memoryId.trim() : "";
  const canonicalKey = typeof payload.canonicalKey === "string" ? payload.canonicalKey.trim() : "";
  const conditions = [eq(agentMemories.agentId, proposal.agentId)];
  if (memoryId) {
    conditions.push(eq(agentMemories.id, memoryId));
  } else {
    if (!canonicalKey) throw new SelfImprovementInputError("canonical_key_not_found");
    const kind = parseMemoryKind(payload.memoryKind ?? payload.kind);
    const memoryType = parseMemoryType(
      payload.memoryType,
      kind === "episode" ? "episodic" : kind === "procedure" ? "procedural" : "semantic",
    );
    conditions.push(
      eq(agentMemories.scopeType, proposal.sessionId ? "session" : "agent"),
      eq(agentMemories.scopeId, proposal.sessionId ?? proposal.agentId),
      eq(agentMemories.memoryType, memoryType),
      eq(agentMemories.canonicalKey, canonicalKey),
    );
  }
  const [target] = await db
    .select()
    .from(agentMemories)
    .where(and(...conditions))
    .orderBy(sql`${agentMemories.updatedAt} desc`)
    .limit(1)
    .for("update");
  if (!target) throw new SelfImprovementInputError("canonical_key_not_found");
  if (!allowArchived && (target.status !== "approved" || target.tombstoned)) {
    throw new SelfImprovementInputError("canonical_target_inactive");
  }
  return target;
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
