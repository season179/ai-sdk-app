import { createHash } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  agentMemories,
  agentMemoryVersions,
  agentMemoryVersionTraceEvents,
  agentProfileFactTombstones,
  agentTraceEvents,
  type MemoryKind,
} from "@/db/schema";
import { getMemoryPolicyVersion } from "@/lib/memory/config";
import { sanitizeTracePayload, sha256 } from "@/lib/memory/redaction";
import { appendTraceEvents } from "@/lib/memory/trace";
import { getProfilePolicyVersion } from "@/lib/profile/config";
import { renderCategorizedProfileText } from "@/lib/profile/context";
import { isCandidateFactSafe } from "@/lib/profile/fact-safety";
import { enqueueProfileSynthesis } from "@/lib/profile/jobs";
import { profileClaimHash, stableFactKeyForClaim } from "@/lib/profile/reconcile";
import {
  applyDirectiveOverlay,
  ensureProfileRoot,
  getCurrentProfile,
  listProfileVersionSources,
} from "@/lib/profile/repository";
import { synthesizeProfile } from "@/lib/profile/synthesis";
import type { ProfileFactCategory, ProfileFactV1, ProfileSourceHandle } from "@/lib/profile/types";
import {
  archiveMemory,
  createMemory,
  setMemoryProtection,
  updateMemory,
} from "@/lib/self-improvement/memories";
import { MEMORY_KINDS } from "@/lib/self-improvement/validation";
import { isUuid } from "@/lib/utils";

const MAX_TEXT_LENGTH = 2_000;
const INLINE_SYNTHESIS_DEADLINE_MS = 1_500;
const EXPLICIT_OVERLAY_PROMPT_HASH = sha256("explicit-profile-overlay-v1");

export type ExplicitProfileIntent =
  | { action: "remember"; content: string; kind?: MemoryKind }
  | {
      action: "forget";
      targetMemoryId?: string;
      targetFactKey?: string;
      targetText?: string;
    }
  | {
      action: "correct";
      content: string;
      targetMemoryId?: string;
      targetFactKey?: string;
      targetText?: string;
      kind?: MemoryKind;
    };

export type ExplicitProfileApplyResult = {
  durable: true;
  action: ExplicitProfileIntent["action"];
  factKey: string;
  memoryId: string | null;
  profileVersionId: string;
  synthesis: "completed" | "queued" | "pending";
};

export class ExplicitProfileIntentError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unauthorized"
      | "unsafe"
      | "invalid"
      | "not_found"
      | "ambiguous"
      | "conflict" = "invalid",
  ) {
    super(message);
    this.name = "ExplicitProfileIntentError";
  }
}

export type ApplyExplicitProfileIntentOptions = {
  agentId: string;
  sessionId: string;
  messageId: string;
  /** Current user message, kept as call context only; it never gates the write. */
  rawUserText: string;
  inlineDeadlineMs?: number;
  synthesize?: typeof synthesizeProfile;
  enqueue?: typeof enqueueProfileSynthesis;
};

type TargetMemory = {
  id: string;
  kind: MemoryKind;
  canonicalKey: string | null;
  status: "creating" | "approved" | "archived";
  tombstoned: boolean;
  isProtected: boolean;
  currentVersionId: string;
  content: string;
  structured: Record<string, unknown>;
};

type ResolvedTarget = {
  factKey: string;
  sentence: string;
  category: ProfileFactCategory;
  protected: boolean;
  memory: TargetMemory | null;
};

type TransactionResult = Omit<ExplicitProfileApplyResult, "synthesis">;

export function explicitProfileIntentFingerprint(intent: ExplicitProfileIntent): string {
  return sha256(
    JSON.stringify({
      action: intent.action,
      content: "content" in intent ? normalizeExact(intent.content) : null,
      targetMemoryId:
        "targetMemoryId" in intent ? (intent.targetMemoryId?.toLocaleLowerCase() ?? null) : null,
      targetFactKey: "targetFactKey" in intent ? (intent.targetFactKey ?? null) : null,
      targetText: "targetText" in intent ? normalizeExact(intent.targetText ?? "") : null,
      kind: "kind" in intent ? (intent.kind ?? null) : null,
    }),
  );
}

/** Conservative route pre-parser. It intentionally recognizes only anchored prefixes. */
export function parseExplicitProfileIntent(rawUserText: string): ExplicitProfileIntent | null {
  const text = rawUserText.trim();
  const remember = /^remember that\s+(.+)$/isu.exec(text);
  if (remember) {
    const content = cleanCommandValue(remember[1]);
    return content ? { action: "remember", content } : null;
  }

  const forget = /^forget\s+(.+)$/isu.exec(text);
  if (forget) {
    const targetText = stripOptionalThat(cleanCommandValue(forget[1]));
    return targetText ? { action: "forget", targetText } : null;
  }

  const correct = /^correct\s+(.+?)\s+to\s+(.+)$/isu.exec(text);
  if (correct) {
    const targetText = stripOptionalThat(cleanCommandValue(correct[1]));
    const content = cleanCommandValue(correct[2]);
    return targetText && content ? { action: "correct", targetText, content } : null;
  }

  return null;
}

/**
 * Commits the explicit trace, memory/tombstone mutation, and deterministic overlay atomically.
 * Model synthesis happens only after that authoritative transaction commits.
 */
export async function applyExplicitProfileIntent(
  intent: ExplicitProfileIntent,
  options: ApplyExplicitProfileIntentOptions,
): Promise<ExplicitProfileApplyResult> {
  validateContext(options);
  validateIntentShape(intent);
  // The tool is a pure executor: whether the user asked for this write is the
  // calling agent's decision. Only deterministic content safety gates remain.
  assertSafeStrings(intentStrings(intent));

  const db = getDb();
  const committed = await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '2000ms'`);
    // Lock the mutable head before assembling the overlay. This prevents a
    // concurrent synthesis/manual commit from landing between our read and B's
    // overlay CAS, which would otherwise drop newly synthesized facts.
    await ensureProfileRoot(options.agentId, tx);
    await tx.execute(
      sql`select agent_id from agent_profiles where agent_id = ${options.agentId} for update`,
    );
    const current = await loadCurrentProjection(options.agentId, tx);
    const replay = await findCommittedReplay(intent.action, options, current, tx);
    if (replay) return replay;

    if (intent.action === "remember") {
      return applyRemember(intent, options, current, tx);
    }

    const target = await resolveTarget(intent, options.agentId, current, tx);
    if (intent.action === "correct") {
      return applyCorrect(intent, target, options, current, tx);
    }
    return applyForget(target, options, current, tx);
  });

  return finishSynthesis(committed, options);
}

async function applyRemember(
  intent: Extract<ExplicitProfileIntent, { action: "remember" }>,
  options: ApplyExplicitProfileIntentOptions,
  current: Awaited<ReturnType<typeof loadCurrentProjection>>,
  tx: AppDbClient,
): Promise<TransactionResult> {
  const kind = intent.kind ?? "fact";
  const sentence = asCompleteSentence(intent.content);
  const canonicalKey = canonicalKeyFor(kind, sentence);
  const factKey = factKeyFor(kind, sentence);
  const existing = current.memories.filter((memory) => memory.canonicalKey === canonicalKey);
  if (existing.length > 1) {
    throw new ExplicitProfileIntentError(
      "The remembered fact matches multiple memories.",
      "ambiguous",
    );
  }
  if (existing[0] && normalizeExact(existing[0].content) !== normalizeExact(sentence)) {
    throw new ExplicitProfileIntentError(
      "A memory with this canonical key already has different content; use correct instead.",
      "conflict",
    );
  }

  const eventId = await appendAuditEvent(intent, options, tx);
  let memoryId: string;
  let memoryVersionId: string;
  if (existing[0]?.status === "approved" && !existing[0].tombstoned) {
    memoryId = existing[0].id;
    memoryVersionId = existing[0].currentVersionId;
  } else if (existing[0]) {
    if (existing[0].isProtected) {
      await setMemoryProtection(existing[0].id, false, options.agentId, "explicit", tx);
    }
    const memory = await updateMemory(
      existing[0].id,
      {
        kind,
        content: sentence,
        source: "user",
        sourceEventIds: [eventId],
        authority: "user",
        structured: { profileDirective: { action: "remember", factKey } },
      },
      options.agentId,
      tx,
    );
    memoryId = memory.id;
    memoryVersionId = memory.currentVersionId;
  } else {
    const memory = await createMemory(
      {
        agentId: options.agentId,
        kind,
        content: sentence,
        source: "user",
        confidence: 100,
        canonicalKey,
        sourceEventIds: [eventId],
        authority: "user",
        structured: { profileDirective: { action: "remember", factKey } },
        // Deliberately omit sessionId: explicit memories are agent-scoped. The trace
        // event carries the originating session/message provenance.
      },
      tx,
    );
    memoryId = memory.id;
    memoryVersionId = memory.currentVersionId;
  }

  await retireTombstone(options.agentId, factKey, sentence, eventId, tx);
  const fact: ProfileFactV1 = {
    factKey,
    sentence,
    category: categoryForKind(kind),
    authority: "user",
    protected: false,
    order: 0,
  };
  const overlay = await commitOverlay(
    options.agentId,
    current,
    { upsertFact: fact, sourceMemoryVersionId: memoryVersionId },
    tx,
  );
  return { ...overlay, durable: true, action: "remember", factKey, memoryId };
}

async function applyCorrect(
  intent: Extract<ExplicitProfileIntent, { action: "correct" }>,
  target: ResolvedTarget,
  options: ApplyExplicitProfileIntentOptions,
  current: Awaited<ReturnType<typeof loadCurrentProjection>>,
  tx: AppDbClient,
): Promise<TransactionResult> {
  const kind = intent.kind ?? target.memory?.kind ?? "correction";
  const sentence = asCompleteSentence(intent.content);
  const eventId = await appendAuditEvent(intent, options, tx);
  let memoryId: string;
  let memoryVersionId: string;

  if (target.memory) {
    const memory = await updateMemory(
      target.memory.id,
      {
        kind,
        content: sentence,
        source: "user",
        sourceEventIds: [eventId],
        authority: "user",
        structured: {
          profileDirective: {
            action: "correct",
            factKey: target.factKey,
            targetFactKey: target.factKey,
          },
        },
      },
      options.agentId,
      tx,
    );
    memoryId = memory.id;
    memoryVersionId = memory.currentVersionId;
  } else {
    const memory = await createMemory(
      {
        agentId: options.agentId,
        kind,
        content: sentence,
        source: "user",
        confidence: 100,
        canonicalKey: `profile:${target.factKey}`,
        sourceEventIds: [eventId],
        authority: "user",
        structured: {
          profileDirective: {
            action: "correct",
            factKey: target.factKey,
            targetFactKey: target.factKey,
          },
        },
      },
      tx,
    );
    memoryId = memory.id;
    memoryVersionId = memory.currentVersionId;
  }

  await retireTombstone(options.agentId, target.factKey, sentence, eventId, tx);
  const fact: ProfileFactV1 = {
    factKey: target.factKey,
    sentence,
    category: intent.kind ? categoryForKind(intent.kind) : target.category,
    authority: "user",
    protected: target.protected,
    order: 0,
  };
  const overlay = await commitOverlay(
    options.agentId,
    current,
    {
      upsertFact: fact,
      sourceMemoryVersionId: memoryVersionId,
      replacedMemoryVersionId: target.memory?.currentVersionId,
      allowedReplacementFactKey: target.factKey,
    },
    tx,
  );
  return {
    ...overlay,
    durable: true,
    action: "correct",
    factKey: target.factKey,
    memoryId,
  };
}

async function applyForget(
  target: ResolvedTarget,
  options: ApplyExplicitProfileIntentOptions,
  current: Awaited<ReturnType<typeof loadCurrentProjection>>,
  tx: AppDbClient,
): Promise<TransactionResult> {
  const eventId = await appendAuditEvent(
    { action: "forget", targetFactKey: target.factKey },
    options,
    tx,
  );
  await tx
    .insert(agentProfileFactTombstones)
    .values({
      agentId: options.agentId,
      factKey: target.factKey,
      deletedBy: "user",
      claimHash: profileClaimHash(target.sentence),
      reason: "Explicit user forget request.",
      explicitTraceEventId: eventId,
    })
    .onConflictDoUpdate({
      target: [agentProfileFactTombstones.agentId, agentProfileFactTombstones.factKey],
      set: {
        deletedAt: sql`now()`,
        deletedBy: "user",
        claimHash: profileClaimHash(target.sentence),
        reason: "Explicit user forget request.",
        explicitTraceEventId: eventId,
        retiredAt: null,
        retiredBy: null,
        retiredTraceEventId: null,
      },
    });

  if (target.memory && target.memory.status !== "archived") {
    if (target.memory.isProtected) {
      await setMemoryProtection(target.memory.id, false, options.agentId, "explicit", tx);
    }
    await archiveMemory(target.memory.id, options.agentId, tx, [eventId]);
  }

  const overlay = await commitOverlay(
    options.agentId,
    current,
    {
      removeFactKey: target.factKey,
      replacedMemoryVersionId: target.memory?.currentVersionId,
    },
    tx,
  );
  return {
    ...overlay,
    durable: true,
    action: "forget",
    factKey: target.factKey,
    memoryId: target.memory?.id ?? null,
  };
}

async function commitOverlay(
  agentId: string,
  current: Awaited<ReturnType<typeof loadCurrentProjection>>,
  operation: {
    upsertFact?: ProfileFactV1;
    removeFactKey?: string;
    sourceMemoryVersionId?: string;
    replacedMemoryVersionId?: string;
    allowedReplacementFactKey?: string;
  },
  tx: AppDbClient,
): Promise<{ profileVersionId: string }> {
  const facts = new Map((current.profile?.facts ?? []).map((fact) => [fact.factKey, fact]));
  if (operation.removeFactKey) facts.delete(operation.removeFactKey);
  if (operation.upsertFact) facts.set(operation.upsertFact.factKey, operation.upsertFact);

  let sources = current.sources.filter((source) => {
    if (operation.removeFactKey && source.factKey === operation.removeFactKey) return false;
    if (operation.upsertFact && source.factKey === operation.upsertFact.factKey) return false;
    if (
      operation.replacedMemoryVersionId &&
      source.memoryVersionId === operation.replacedMemoryVersionId
    ) {
      return false;
    }
    return true;
  });
  const sourcedKeys = new Set(sources.map((source) => source.factKey));
  for (const factKey of [...facts.keys()]) {
    if (operation.upsertFact?.factKey === factKey) continue;
    if (!sourcedKeys.has(factKey)) facts.delete(factKey);
  }
  if (operation.upsertFact && operation.sourceMemoryVersionId) {
    sources.push({
      factKey: operation.upsertFact.factKey,
      sourceRole: "primary",
      traceEventId: null,
      memoryVersionId: operation.sourceMemoryVersionId,
    });
  }

  const orderedFacts = [...facts.values()]
    .sort((a, b) => a.order - b.order || a.factKey.localeCompare(b.factKey))
    .map((fact, order) => ({ ...fact, order }));
  const keptKeys = new Set(orderedFacts.map((fact) => fact.factKey));
  sources = dedupeSources(sources.filter((source) => keptKeys.has(source.factKey)));
  const body = renderCategorizedProfileText(orderedFacts);
  const result = await applyDirectiveOverlay(
    {
      agentId,
      facts: orderedFacts,
      sources,
      body,
      tokenCount: body ? Math.max(1, Math.ceil([...body].length / 4)) : 0,
      trigger: "explicit",
      modelId: null,
      promptHash: EXPLICIT_OVERLAY_PROMPT_HASH,
      policyVersion: getProfilePolicyVersion(),
      allowedReplacementFactKeys: operation.allowedReplacementFactKey
        ? [operation.allowedReplacementFactKey]
        : undefined,
    },
    tx,
  );
  if (!result.profileVersionId)
    throw new Error("Explicit overlay did not create a profile version.");
  return { profileVersionId: result.profileVersionId };
}

async function loadCurrentProjection(agentId: string, tx: AppDbClient) {
  const profile = await getCurrentProfile(agentId, { db: tx });
  const sources = profile ? await listProfileVersionSources(profile.id, agentId, tx) : [];
  const rows = await tx
    .select({ root: agentMemories, version: agentMemoryVersions })
    .from(agentMemories)
    .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId))
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.scopeType, "agent"),
        eq(agentMemories.scopeId, agentId),
        sql`${agentMemories.status} <> 'creating'`,
      ),
    )
    .orderBy(desc(agentMemories.updatedAt), desc(agentMemories.id));
  const memories: TargetMemory[] = rows.map(({ root, version }) => ({
    id: root.id,
    kind: root.kind,
    canonicalKey: root.canonicalKey,
    status: root.status,
    tombstoned: root.tombstoned,
    isProtected: root.isProtected,
    currentVersionId: version.id,
    content: version.content,
    structured: version.structured,
  }));
  return { profile, sources, memories };
}

async function resolveTarget(
  intent: Extract<ExplicitProfileIntent, { action: "forget" | "correct" }>,
  agentId: string,
  current: Awaited<ReturnType<typeof loadCurrentProjection>>,
  tx: AppDbClient,
): Promise<ResolvedTarget> {
  const selectors = [intent.targetMemoryId, intent.targetFactKey, intent.targetText].filter(
    (value): value is string => Boolean(value),
  );
  if (selectors.length !== 1) {
    throw new ExplicitProfileIntentError(
      "Exactly one forget/correct target is required.",
      "invalid",
    );
  }

  // Lock possible backing roots before mutation. Scope is always reapplied server-side.
  await tx.execute(
    sql`select id from agent_memories where agent_id = ${agentId} and scope_type = 'agent' and scope_id = ${agentId} for update`,
  );
  const profileFacts = current.profile?.facts ?? [];
  const profileByKey = new Map(profileFacts.map((fact) => [fact.factKey, fact]));
  const candidates = new Map<string, ResolvedTarget>();

  for (const memory of current.memories) {
    const directive = readProfileDirective(memory.structured);
    const factKey = directive.factKey ?? factKeyFor(memory.kind, memory.content);
    const profileFact = profileByKey.get(factKey);
    const candidate = {
      factKey,
      sentence: profileFact?.sentence ?? memory.content,
      category: profileFact?.category ?? categoryForKind(memory.kind),
      protected: profileFact?.protected ?? memory.isProtected,
      memory,
    };
    candidates.set(candidates.has(factKey) ? `${factKey}:${memory.id}` : factKey, candidate);
  }
  for (const fact of profileFacts) {
    const prior = candidates.get(fact.factKey);
    candidates.set(fact.factKey, {
      factKey: fact.factKey,
      sentence: fact.sentence,
      category: fact.category,
      protected: fact.protected,
      memory: prior?.memory ?? memoryForFactKey(current.memories, fact.factKey),
    });
  }

  let matches: ResolvedTarget[];
  if (intent.targetMemoryId) {
    if (!isUuid(intent.targetMemoryId)) {
      throw new ExplicitProfileIntentError("targetMemoryId must be a UUID.", "invalid");
    }
    matches = [...candidates.values()].filter(
      (candidate) => candidate.memory?.id === intent.targetMemoryId,
    );
  } else if (intent.targetFactKey) {
    matches = [...candidates.values()].filter(
      (candidate) => candidate.factKey === intent.targetFactKey,
    );
  } else {
    const target = normalizeExact(intent.targetText ?? "");
    matches = [...candidates.values()].filter(
      (candidate) =>
        normalizeExact(candidate.sentence) === target ||
        (candidate.memory && normalizeExact(candidate.memory.content) === target),
    );
  }

  if (matches.length === 0) {
    throw new ExplicitProfileIntentError("No exact memory/profile target was found.", "not_found");
  }
  if (matches.length > 1) {
    throw new ExplicitProfileIntentError(
      "The target matches multiple memories/profile facts; provide an exact id or fact key.",
      "ambiguous",
    );
  }
  return matches[0];
}

async function findCommittedReplay(
  action: ExplicitProfileIntent["action"],
  options: ApplyExplicitProfileIntentOptions,
  current: Awaited<ReturnType<typeof loadCurrentProjection>>,
  tx: AppDbClient,
): Promise<TransactionResult | null> {
  const [event] = await tx
    .select({ id: agentTraceEvents.id })
    .from(agentTraceEvents)
    .where(
      and(
        eq(agentTraceEvents.agentId, options.agentId),
        eq(agentTraceEvents.idempotencyKey, auditIdentity(action, options).idempotencyKey),
      ),
    )
    .limit(1);
  if (!event || !current.profile) return null;

  const [memoryRow] = await tx
    .select({ root: agentMemories, version: agentMemoryVersions })
    .from(agentMemoryVersionTraceEvents)
    .innerJoin(
      agentMemoryVersions,
      eq(agentMemoryVersions.id, agentMemoryVersionTraceEvents.memoryVersionId),
    )
    .innerJoin(agentMemories, eq(agentMemories.id, agentMemoryVersions.memoryId))
    .where(
      and(
        eq(agentMemoryVersionTraceEvents.eventId, event.id),
        eq(agentMemories.agentId, options.agentId),
      ),
    )
    .orderBy(desc(agentMemoryVersions.versionNo))
    .limit(1);
  const [tombstone] = await tx
    .select({ factKey: agentProfileFactTombstones.factKey })
    .from(agentProfileFactTombstones)
    .where(
      and(
        eq(agentProfileFactTombstones.agentId, options.agentId),
        eq(agentProfileFactTombstones.explicitTraceEventId, event.id),
      ),
    )
    .limit(1);
  const factKey =
    tombstone?.factKey ??
    (memoryRow ? readProfileDirective(memoryRow.version.structured).factKey : undefined);
  if (!factKey) return null;
  return {
    durable: true,
    action,
    factKey,
    memoryId: memoryRow?.root.id ?? null,
    profileVersionId: current.profile.id,
  };
}

async function appendAuditEvent(
  intent: ExplicitProfileIntent,
  options: ApplyExplicitProfileIntentOptions,
  tx: AppDbClient,
): Promise<string> {
  const { identity, idempotencyKey } = auditIdentity(intent.action, options);
  const sanitized = sanitizeTracePayload({
    action: intent.action,
    content: "content" in intent ? intent.content : undefined,
    targetMemoryId: "targetMemoryId" in intent ? intent.targetMemoryId : undefined,
    targetFactKey: "targetFactKey" in intent ? intent.targetFactKey : undefined,
    targetText: "targetText" in intent ? intent.targetText : undefined,
  });
  if (sanitized.secretDetected || sanitized.injectionDetected) {
    throw new ExplicitProfileIntentError("Unsafe explicit memory content was rejected.", "unsafe");
  }
  const [event] = await appendTraceEvents(
    [
      {
        agentId: options.agentId,
        traceId: `explicit-profile:${createHash("sha256").update(identity).digest("hex")}`,
        sequenceNo: 0,
        sessionId: options.sessionId,
        sourceMessageId: options.messageId,
        eventType: "explicit_memory_write",
        actor: "user",
        trustClass: "user_assertion",
        payload: sanitized.payload,
        contentHash: sanitized.contentHash,
        idempotencyKey,
        retentionClass: "audit",
        policyVersion: getMemoryPolicyVersion(),
        occurredAt: new Date(),
      },
    ],
    tx,
  );
  if (!event) throw new Error("Explicit memory audit event was not persisted.");
  return event.id;
}

async function retireTombstone(
  agentId: string,
  factKey: string,
  sentence: string,
  eventId: string,
  tx: AppDbClient,
): Promise<void> {
  await tx
    .update(agentProfileFactTombstones)
    .set({ retiredAt: sql`now()`, retiredBy: "user", retiredTraceEventId: eventId })
    .where(
      and(
        eq(agentProfileFactTombstones.agentId, agentId),
        sql`(${agentProfileFactTombstones.factKey} = ${factKey} or ${agentProfileFactTombstones.claimHash} = ${profileClaimHash(sentence)})`,
        sql`${agentProfileFactTombstones.retiredAt} is null`,
      ),
    );
}

async function finishSynthesis(
  committed: TransactionResult,
  options: ApplyExplicitProfileIntentOptions,
): Promise<ExplicitProfileApplyResult> {
  const synthesisKey = `explicit:${options.sessionId}:${options.messageId}:${committed.action}`;
  const synthesis = (options.synthesize ?? synthesizeProfile)(options.agentId, {
    trigger: "explicit",
    synthesisKey,
    maxAttempts: 2,
  });
  const timeoutMs = Math.max(1, options.inlineDeadlineMs ?? INLINE_SYNTHESIS_DEADLINE_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    synthesis.then(
      () => "completed" as const,
      () => "failed" as const,
    ),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === "completed") return { ...committed, synthesis: "completed" };

  // A timed-out synthesis is allowed to finish: its receipt/advisory lock/CAS make
  // the late result safe. The singleton fallback covers timeout, failure, and CAS loss.
  void synthesis.catch(() => undefined);
  try {
    const jobId = await (options.enqueue ?? enqueueProfileSynthesis)(options.agentId, {
      trigger: "explicit_fallback",
    });
    if (!jobId) {
      console.warn("Explicit profile synthesis remains dirty; fallback queue is disabled.");
      return { ...committed, synthesis: "pending" };
    }
    return { ...committed, synthesis: "queued" };
  } catch (error) {
    // Durable dirty state remains catch-up eligible, but no queue claim is made.
    console.error("Enqueuing explicit profile synthesis fallback failed", error);
    return { ...committed, synthesis: "pending" };
  }
}

function auditIdentity(
  action: ExplicitProfileIntent["action"],
  options: ApplyExplicitProfileIntentOptions,
): { identity: string; idempotencyKey: string } {
  const identity = `${options.agentId}:${options.sessionId}:${options.messageId}:${action}`;
  return { identity, idempotencyKey: `explicit-profile:${identity}` };
}

function validateContext(options: ApplyExplicitProfileIntentOptions): void {
  if (!isUuid(options.agentId) || !isUuid(options.sessionId) || !options.messageId.trim()) {
    throw new ExplicitProfileIntentError("A persisted agent/session/message scope is required.");
  }
}

function validateIntentShape(intent: ExplicitProfileIntent): void {
  if (intent.action === "remember") {
    if (!intent.content?.trim()) throw new ExplicitProfileIntentError("Remember requires content.");
  } else {
    const selectors = [intent.targetMemoryId, intent.targetFactKey, intent.targetText].filter(
      Boolean,
    );
    if (selectors.length !== 1) {
      throw new ExplicitProfileIntentError("Exactly one forget/correct target is required.");
    }
    if (intent.action === "correct" && !intent.content?.trim()) {
      throw new ExplicitProfileIntentError("Correct requires replacement content.");
    }
  }
  if ("kind" in intent && intent.kind && !MEMORY_KINDS.includes(intent.kind)) {
    throw new ExplicitProfileIntentError("Invalid memory kind.");
  }
  for (const value of intentStrings(intent)) {
    if (!value.trim() || [...value].length > MAX_TEXT_LENGTH || /[\r\n]/.test(value)) {
      throw new ExplicitProfileIntentError(
        "Explicit memory text must be 1-2000 single-line characters.",
      );
    }
  }
}

function assertSafeStrings(values: string[]): void {
  for (const value of values) {
    if (!isCandidateFactSafe(value)) {
      throw new ExplicitProfileIntentError(
        "Unsafe explicit memory content was rejected.",
        "unsafe",
      );
    }
  }
}

function intentStrings(intent: ExplicitProfileIntent): string[] {
  return [
    "content" in intent ? intent.content : undefined,
    "targetText" in intent ? intent.targetText : undefined,
  ].filter((value): value is string => value !== undefined);
}

function readProfileDirective(structured: Record<string, unknown>): { factKey?: string } {
  const value = structured.profileDirective;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const factKey = (value as Record<string, unknown>).factKey;
  return typeof factKey === "string" && factKey ? { factKey } : {};
}

function memoryForFactKey(memories: TargetMemory[], factKey: string): TargetMemory | null {
  return (
    memories.find((memory) => readProfileDirective(memory.structured).factKey === factKey) ?? null
  );
}

function canonicalKeyFor(_kind: MemoryKind, sentence: string): string {
  return `profile:${profileClaimHash(sentence)}`;
}

function factKeyFor(_kind: MemoryKind, sentence: string): string {
  return stableFactKeyForClaim(sentence);
}

function categoryForKind(kind: MemoryKind): ProfileFactCategory {
  if (kind === "preference") return "preferences_constraints";
  if (kind === "procedure") return "interaction_instructions";
  if (kind === "episode") return "active_projects_goals";
  return "identity_context";
}

function asCompleteSentence(value: string): string {
  const text = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return /[.!?。！？]$/u.test(text) ? text : `${text}.`;
}

function normalizeExact(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!?。！？]+$/u, "");
}

function cleanCommandValue(value: string): string {
  return value.trim();
}

function stripOptionalThat(value: string): string {
  return value.replace(/^that\s+/iu, "").trim();
}

function dedupeSources(sources: ProfileSourceHandle[]): ProfileSourceHandle[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.factKey}:${source.traceEventId ?? ""}:${source.memoryVersionId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
