import { and, eq, inArray, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  agentMemories,
  agentMemoryVersions,
  agentMemoryVersionTraceEvents,
  agentTraceEvents,
  type MemoryConflictPolicy,
  type MemoryKind,
  type MemorySource,
  type MemoryType,
  type SensitivityClass,
} from "@/db/schema";
import { getMemoryPolicyVersion } from "@/lib/memory/config";

export type VersionAuthority = "user" | "tool" | "reviewed" | "consolidated" | "legacy_import";
export type VersionedMemoryInput = {
  agentId: string;
  kind: MemoryKind;
  memoryType?: MemoryType;
  content: string;
  source: MemorySource;
  confidence: number;
  sourceEventIds: string[];
  authority: VersionAuthority;
  sessionId?: string | null;
  reviewProposalId?: string | null;
  claimHash?: string | null;
  canonicalKey?: string | null;
  scopeType?: "agent" | "session" | "task";
  scopeId?: string;
  conflictPolicy?: MemoryConflictPolicy;
  structured?: Record<string, unknown>;
  validFrom?: Date | null;
  validTo?: Date | null;
  sourceReferenceTime?: Date | null;
  timePrecision?: "instant" | "day" | "month" | "year" | "unknown";
  timeSource?: string | null;
  observedAt?: Date | null;
  lastConfirmedAt?: Date | null;
  expiresAt?: Date | null;
  importance?: number;
  utilityScoreBps?: number;
  sensitivityClass?: SensitivityClass;
  extractorId?: string | null;
  modelId?: string | null;
  promptHash?: string | null;
  schemaVersion?: number;
  policyVersion?: string;
};

function family(kind: MemoryKind, requested?: MemoryType): MemoryType {
  const expected =
    kind === "episode" ? "episodic" : kind === "procedure" ? "procedural" : "semantic";
  if (requested && requested !== expected)
    throw new Error(`Memory kind ${kind} requires type ${expected}.`);
  return expected;
}

function defaultConflict(kind: MemoryKind): MemoryConflictPolicy {
  if (["preference", "persona", "correction"].includes(kind)) return "replace_current";
  if (kind === "procedure") return "version_evaluate";
  if (kind === "episode") return "add_only";
  return "append_temporal";
}

async function verifyEvidence(agentId: string, ids: string[], db: AppDbClient) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new Error("Curated memory writes require trace evidence.");
  const rows = await db
    .select({ id: agentTraceEvents.id })
    .from(agentTraceEvents)
    .where(and(eq(agentTraceEvents.agentId, agentId), inArray(agentTraceEvents.id, unique)))
    .for("update");
  if (rows.length !== unique.length) throw new Error("Memory evidence is missing or foreign.");
  return unique;
}

function validity(input: Pick<VersionedMemoryInput, "validFrom" | "validTo">) {
  if (!input.validFrom && !input.validTo) return null;
  if (input.validFrom && input.validTo && input.validFrom >= input.validTo) {
    throw new Error("Memory validFrom must be earlier than validTo.");
  }
  return sql`tstzrange(${input.validFrom ?? null}, ${input.validTo ?? null}, '[)')`;
}

export async function createVersionedMemory(input: VersionedMemoryInput, outerDb?: AppDbClient) {
  const run = async (db: AppDbClient) => {
    const eventIds = await verifyEvidence(input.agentId, input.sourceEventIds, db);
    const memoryType = family(input.kind, input.memoryType);
    const now = new Date();
    const [root] = await db
      .insert(agentMemories)
      .values({
        agentId: input.agentId,
        kind: input.kind,
        memoryType,
        canonicalKey: input.canonicalKey ?? null,
        conflictPolicy: input.conflictPolicy ?? defaultConflict(input.kind),
        scopeType: input.scopeType ?? (input.sessionId ? "session" : "agent"),
        scopeId: input.scopeId ?? input.sessionId ?? input.agentId,
        status: "creating",
        sessionId: input.sessionId ?? null,
        reviewProposalId: input.reviewProposalId ?? null,
        claimHash: input.claimHash ?? null,
      })
      .returning();
    const [version] = await db
      .insert(agentMemoryVersions)
      .values({
        memoryId: root.id,
        versionNo: 1,
        content: input.content,
        structured: input.structured ?? {},
        source: input.source,
        validDuring: validity(input),
        recordedDuring: sql`tstzrange(${now}, NULL, '[)')`,
        sourceReferenceTime: input.sourceReferenceTime ?? null,
        timePrecision: input.timePrecision ?? "unknown",
        timeSource: input.timeSource ?? null,
        observedAt: input.observedAt ?? null,
        lastConfirmedAt: input.lastConfirmedAt ?? null,
        expiresAt: input.expiresAt ?? null,
        confidence: input.confidence,
        importance: input.importance ?? 50,
        utilityScoreBps: input.utilityScoreBps ?? 0,
        operation: "ADD",
        extractorId: input.extractorId ?? null,
        modelId: input.modelId ?? null,
        promptHash: input.promptHash ?? null,
        schemaVersion: input.schemaVersion ?? 1,
        policyVersion: input.policyVersion ?? getMemoryPolicyVersion(),
        authority: input.authority,
        sensitivityClass: input.sensitivityClass ?? "normal",
      })
      .returning();
    await db.insert(agentMemoryVersionTraceEvents).values(
      eventIds.map((eventId, index) => ({
        memoryVersionId: version.id,
        eventId,
        sourceRole: index === 0 ? ("primary" as const) : ("corroborating" as const),
      })),
    );
    const [updated] = await db
      .update(agentMemories)
      .set({ currentVersionId: version.id, status: "approved", updatedAt: now })
      .where(eq(agentMemories.id, root.id))
      .returning();
    return { root: updated, version };
  };
  return outerDb ? run(outerDb) : getDb().transaction(run);
}

export async function appendMemoryVersion(
  memoryId: string,
  input: Omit<VersionedMemoryInput, "claimHash" | "canonicalKey" | "scopeType" | "scopeId">,
  outerDb?: AppDbClient,
) {
  const run = async (db: AppDbClient) => {
    const eventIds = await verifyEvidence(input.agentId, input.sourceEventIds, db);
    const [root] = await db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.id, memoryId), eq(agentMemories.agentId, input.agentId)))
      .for("update");
    if (!root || !root.currentVersionId) throw new Error(`Memory ${memoryId} was not found.`);
    family(input.kind, input.memoryType);
    const [current] = await db
      .select()
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.id, root.currentVersionId))
      .for("update");
    if (!current) throw new Error("Current memory version is missing.");
    const now = new Date();
    await db
      .update(agentMemoryVersions)
      .set({
        recordedDuring: sql`tstzrange(lower(${agentMemoryVersions.recordedDuring}), ${now}, '[)')`,
      })
      .where(eq(agentMemoryVersions.id, current.id));
    const [version] = await db
      .insert(agentMemoryVersions)
      .values({
        memoryId,
        versionNo: current.versionNo + 1,
        content: input.content,
        structured: input.structured ?? current.structured,
        source: input.source,
        validDuring:
          input.validFrom === undefined && input.validTo === undefined
            ? current.validDuring
            : validity(input),
        recordedDuring: sql`tstzrange(${now}, NULL, '[)')`,
        sourceReferenceTime:
          input.sourceReferenceTime === undefined
            ? current.sourceReferenceTime
            : input.sourceReferenceTime,
        timePrecision: input.timePrecision ?? current.timePrecision,
        timeSource: input.timeSource === undefined ? current.timeSource : input.timeSource,
        observedAt: input.observedAt === undefined ? current.observedAt : input.observedAt,
        lastConfirmedAt:
          input.lastConfirmedAt === undefined ? current.lastConfirmedAt : input.lastConfirmedAt,
        expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
        confidence: input.confidence,
        importance: input.importance ?? current.importance,
        utilityScoreBps: input.utilityScoreBps ?? current.utilityScoreBps,
        operation: "UPDATE",
        supersedesMemoryVersionId: current.id,
        extractorId: input.extractorId ?? null,
        modelId: input.modelId ?? null,
        promptHash: input.promptHash ?? null,
        schemaVersion: input.schemaVersion ?? 1,
        policyVersion: input.policyVersion ?? getMemoryPolicyVersion(),
        authority: input.authority,
        sensitivityClass: input.sensitivityClass ?? current.sensitivityClass,
      })
      .returning();
    await db.insert(agentMemoryVersionTraceEvents).values(
      eventIds.map((eventId, index) => ({
        memoryVersionId: version.id,
        eventId,
        sourceRole: index === 0 ? ("primary" as const) : ("corroborating" as const),
      })),
    );
    const [updated] = await db
      .update(agentMemories)
      .set({
        kind: input.kind,
        memoryType: family(input.kind, input.memoryType),
        conflictPolicy:
          input.kind === root.kind ? root.conflictPolicy : defaultConflict(input.kind),
        currentVersionId: version.id,
        status: "approved",
        tombstoned: false,
        tombstonedAt: null,
        updatedAt: now,
      })
      .where(eq(agentMemories.id, memoryId))
      .returning();
    return { root: updated, version };
  };
  return outerDb ? run(outerDb) : getDb().transaction(run);
}

export async function invalidateMemory(
  memoryId: string,
  input: {
    agentId: string;
    sourceEventIds: string[];
    source: MemorySource;
    authority: VersionAuthority;
    policyVersion?: string;
  },
  outerDb?: AppDbClient,
) {
  const run = async (db: AppDbClient) => {
    const eventIds = await verifyEvidence(input.agentId, input.sourceEventIds, db);
    const [root] = await db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.id, memoryId), eq(agentMemories.agentId, input.agentId)))
      .for("update");
    if (!root?.currentVersionId) throw new Error(`Memory ${memoryId} was not found.`);
    const [current] = await db
      .select()
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.id, root.currentVersionId))
      .for("update");
    if (!current) throw new Error("Current memory version is missing.");
    const now = new Date();
    await db
      .update(agentMemoryVersions)
      .set({
        recordedDuring: sql`tstzrange(lower(${agentMemoryVersions.recordedDuring}), ${now}, '[)')`,
      })
      .where(eq(agentMemoryVersions.id, current.id));
    const [version] = await db
      .insert(agentMemoryVersions)
      .values({
        memoryId,
        versionNo: current.versionNo + 1,
        content: current.content,
        structured: current.structured,
        source: input.source,
        validDuring: current.validDuring,
        recordedDuring: sql`tstzrange(${now}, NULL, '[)')`,
        sourceReferenceTime: current.sourceReferenceTime,
        timePrecision: current.timePrecision,
        timeSource: current.timeSource,
        observedAt: current.observedAt,
        lastConfirmedAt: current.lastConfirmedAt,
        expiresAt: current.expiresAt,
        confidence: current.confidence,
        importance: current.importance,
        utilityScoreBps: current.utilityScoreBps,
        operation: "INVALIDATE",
        supersedesMemoryVersionId: current.id,
        policyVersion: input.policyVersion ?? getMemoryPolicyVersion(),
        authority: input.authority,
        sensitivityClass: current.sensitivityClass,
      })
      .returning();
    await db.insert(agentMemoryVersionTraceEvents).values(
      eventIds.map((eventId, index) => ({
        memoryVersionId: version.id,
        eventId,
        sourceRole: index === 0 ? ("primary" as const) : ("context" as const),
      })),
    );
    const [updated] = await db
      .update(agentMemories)
      .set({
        currentVersionId: version.id,
        status: "archived",
        tombstoned: true,
        tombstonedAt: now,
        updatedAt: now,
      })
      .where(eq(agentMemories.id, memoryId))
      .returning();
    return { root: updated, version };
  };
  return outerDb ? run(outerDb) : getDb().transaction(run);
}
