import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  agentChatSessions,
  agentGroundedObservations,
  agentMemories,
  agentMemoryVersions,
  agentMemoryVersionTraceEvents,
  agentProfileFactTombstones,
  agentProfileSynthesisReceipts,
  agentProfiles,
  agentProfileVersionSources,
  agentProfileVersions,
  agentTraceEvents,
} from "@/db/schema";
import { getProfileMaxChars, getProfileTokenBudget } from "@/lib/profile/config";
import { assertMandatoryFactsRenderable } from "@/lib/profile/render";
import type {
  CurrentProfile,
  ProfileFactV1,
  ProfileMemoryInput,
  ProfileObservationInput,
  ProfileSourceHandle,
  ProfileSourceState,
  ProfileSynthesisResult,
  ProfileSynthesisSnapshot,
  ProfileTombstone,
  ProfileTuple,
  ProfileVersion,
  ProfileVersionAuthority,
  ProfileVersionTrigger,
  ProfileWatermarks,
} from "@/lib/profile/types";
import { validateProfileCandidate } from "@/lib/profile/validate";

const ALLOWED_MEMORY_SOURCES = ["user", "review", "curated", "consolidated"] as const;

/** One eligibility predicate for catch-up, timestamp reads, and generation paging. */
function eligibleObservationConditions(agentId: string) {
  return [
    eq(agentGroundedObservations.agentId, agentId),
    isNull(agentGroundedObservations.deletedAt),
    sql`coalesce(${agentTraceEvents.payload}->>'projectionContaminated', 'false') <> 'true'`,
    or(
      and(
        eq(agentGroundedObservations.originKind, "memory_user"),
        isNull(agentGroundedObservations.sessionId),
      ),
      and(
        eq(agentGroundedObservations.originKind, "chat_user"),
        eq(agentChatSessions.agentId, agentId),
        eq(agentChatSessions.origin, "chat"),
        isNull(agentChatSessions.deletedAt),
      ),
    ),
    sql`(
      ${agentTraceEvents.eventType} in ('explicit_memory_write', 'legacy_import')
      or (
        select terminal.terminal_status
        from agent_trace_events terminal
        where terminal.agent_id = ${agentTraceEvents.agentId}
          and terminal.trace_id = ${agentTraceEvents.traceId}
          and terminal.event_type = 'task_terminal_state'
        order by terminal.sequence_no desc, terminal.ingested_at desc
        limit 1
      ) = 'completed'
    )`,
  ];
}

export class ProfileGenerationConflictError extends Error {
  constructor() {
    super("Profile head or dirty generation changed during synthesis.");
    this.name = "ProfileGenerationConflictError";
  }
}

export class ProfileSourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileSourceValidationError";
  }
}

type ReadOptions = { signal?: AbortSignal; deadlineAt?: number; db?: AppDbClient };

function assertReadCanStart(options: ReadOptions): void {
  if (
    options.signal?.aborted ||
    (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
  ) {
    throw new DOMException("Profile read deadline elapsed.", "AbortError");
  }
}

export async function getCurrentProfile(
  agentId: string,
  options: ReadOptions = {},
): Promise<CurrentProfile | null> {
  assertReadCanStart(options);
  const db = options.db ?? getDb();
  const [row] = await db
    .select({ root: agentProfiles, version: agentProfileVersions })
    .from(agentProfiles)
    .innerJoin(agentProfileVersions, eq(agentProfileVersions.id, agentProfiles.currentVersionId))
    .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfileVersions.agentId, agentId)))
    .limit(1);
  if (!row) return null;
  return {
    ...mapVersion(row.version),
    dirtyGeneration: row.root.dirtyGeneration,
    synthesizedGeneration: row.root.synthesizedGeneration,
    lastSynthesisAttemptAt: row.root.lastSynthesisAttemptAt,
    lastSynthesizedAt: row.root.lastSynthesizedAt,
    lastSynthesisError: row.root.lastSynthesisError,
  };
}

export async function getProfileVersion(
  id: string,
  agentId: string,
  options: ReadOptions = {},
): Promise<ProfileVersion | null> {
  assertReadCanStart(options);
  const [row] = await (options.db ?? getDb())
    .select()
    .from(agentProfileVersions)
    .where(and(eq(agentProfileVersions.id, id), eq(agentProfileVersions.agentId, agentId)))
    .limit(1);
  return row ? mapVersion(row) : null;
}

export async function listProfileVersionSources(
  profileVersionId: string,
  agentId: string,
  db: AppDbClient = getDb(),
): Promise<ProfileSourceHandle[]> {
  const rows = await db
    .select({ source: agentProfileVersionSources })
    .from(agentProfileVersionSources)
    .innerJoin(
      agentProfileVersions,
      eq(agentProfileVersions.id, agentProfileVersionSources.profileVersionId),
    )
    .where(
      and(
        eq(agentProfileVersionSources.profileVersionId, profileVersionId),
        eq(agentProfileVersions.agentId, agentId),
      ),
    );
  return rows.map((row) => mapSource(row.source));
}

export async function ensureProfileRoot(
  agentId: string,
  db: AppDbClient = getDb(),
): Promise<typeof agentProfiles.$inferSelect> {
  await db.insert(agentProfiles).values({ agentId }).onConflictDoNothing();
  const [root] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .limit(1);
  if (!root) throw new Error("Unable to initialize profile root.");
  return root;
}

export async function markProfileDirty(
  agentId: string,
  db: AppDbClient = getDb(),
): Promise<number> {
  await ensureProfileRoot(agentId, db);
  const [root] = await db
    .select({ dirtyGeneration: agentProfiles.dirtyGeneration })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .for("update");
  if (!root) throw new Error("Unable to lock profile root.");

  // Reserve generations for any eligible dark-write evidence first, then one
  // generation for the authoritative mutation the caller is about to commit.
  const caughtUp = await assignEligibleNullGenerationsUnderRootLock(
    agentId,
    root.dirtyGeneration,
    db,
  );
  const dirtyGeneration = caughtUp.dirtyGeneration + 1;
  await db
    .update(agentProfiles)
    .set({ dirtyGeneration, updatedAt: sql`now()` })
    .where(eq(agentProfiles.agentId, agentId));
  return dirtyGeneration;
}

/**
 * Enablement catch-up for evidence collected while profile synthesis was off.
 * The profile root is always locked before evidence rows, matching live writer
 * lock order. Ineligible/deleted rows remain generationless.
 */
export async function catchUpEligibleNullProfileGenerations(
  agentId: string,
  db?: AppDbClient,
): Promise<{ assigned: number; dirtyGeneration: number }> {
  if (!db) {
    return getDb().transaction((tx) => catchUpEligibleNullProfileGenerations(agentId, tx));
  }
  await ensureProfileRoot(agentId, db);
  const [root] = await db
    .select({ dirtyGeneration: agentProfiles.dirtyGeneration })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .for("update");
  if (!root) throw new Error("Unable to lock profile root for evidence catch-up.");
  return assignEligibleNullGenerationsUnderRootLock(agentId, root.dirtyGeneration, db);
}

async function assignEligibleNullGenerationsUnderRootLock(
  agentId: string,
  dirtyGeneration: number,
  db: AppDbClient,
): Promise<{ assigned: number; dirtyGeneration: number }> {
  const observations = await db
    .select({ id: agentGroundedObservations.id, createdAt: agentGroundedObservations.createdAt })
    .from(agentGroundedObservations)
    .innerJoin(agentTraceEvents, eq(agentTraceEvents.id, agentGroundedObservations.traceEventId))
    .leftJoin(agentChatSessions, eq(agentChatSessions.id, agentGroundedObservations.sessionId))
    .where(
      and(
        ...eligibleObservationConditions(agentId),
        isNull(agentGroundedObservations.profileGeneration),
      ),
    );
  const memories = await db
    .select({ id: agentMemoryVersions.id, createdAt: agentMemoryVersions.createdAt })
    .from(agentMemoryVersions)
    .innerJoin(agentMemories, eq(agentMemories.id, agentMemoryVersions.memoryId))
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        isNull(agentMemoryVersions.profileGeneration),
        inArray(agentMemoryVersions.source, [...ALLOWED_MEMORY_SOURCES]),
      ),
    );
  const pending = [
    ...observations.map((row) => ({ ...row, lane: "observation" as const })),
    ...memories.map((row) => ({ ...row, lane: "memory" as const })),
  ].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id) ||
      a.lane.localeCompare(b.lane),
  );
  for (const [index, item] of pending.entries()) {
    const profileGeneration = dirtyGeneration + index + 1;
    if (item.lane === "observation") {
      await db
        .update(agentGroundedObservations)
        .set({ profileGeneration })
        .where(
          and(
            eq(agentGroundedObservations.id, item.id),
            isNull(agentGroundedObservations.profileGeneration),
          ),
        );
    } else {
      await db
        .update(agentMemoryVersions)
        .set({ profileGeneration })
        .where(
          and(eq(agentMemoryVersions.id, item.id), isNull(agentMemoryVersions.profileGeneration)),
        );
    }
  }
  const nextDirtyGeneration = dirtyGeneration + pending.length;
  if (pending.length > 0) {
    await db
      .update(agentProfiles)
      .set({ dirtyGeneration: nextDirtyGeneration, updatedAt: sql`now()` })
      .where(eq(agentProfiles.agentId, agentId));
  }
  return { assigned: pending.length, dirtyGeneration: nextDirtyGeneration };
}

/** Assigns commit-ordered generations to observations made eligible by a completed trace. */
export async function assignCompletedTraceProfileGenerations(
  agentId: string,
  traceId: string,
  db: AppDbClient = getDb(),
): Promise<number | null> {
  await ensureProfileRoot(agentId, db);
  const [root] = await db
    .select({ dirtyGeneration: agentProfiles.dirtyGeneration })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .for("update");
  if (!root) throw new Error("Profile root unavailable while completing trace evidence.");
  const rows = await db
    .select({ id: agentGroundedObservations.id })
    .from(agentGroundedObservations)
    .innerJoin(agentTraceEvents, eq(agentTraceEvents.id, agentGroundedObservations.traceEventId))
    .leftJoin(agentChatSessions, eq(agentChatSessions.id, agentGroundedObservations.sessionId))
    .where(
      and(
        ...eligibleObservationConditions(agentId),
        eq(agentTraceEvents.traceId, traceId),
        isNull(agentGroundedObservations.profileGeneration),
      ),
    )
    .orderBy(asc(agentGroundedObservations.createdAt), asc(agentGroundedObservations.id));
  if (!rows.length) return null;
  for (const [index, row] of rows.entries()) {
    await db
      .update(agentGroundedObservations)
      .set({ profileGeneration: root.dirtyGeneration + index + 1 })
      .where(
        and(
          eq(agentGroundedObservations.id, row.id),
          isNull(agentGroundedObservations.profileGeneration),
        ),
      );
  }
  const generation = root.dirtyGeneration + rows.length;
  await db
    .update(agentProfiles)
    .set({ dirtyGeneration: generation, updatedAt: sql`now()` })
    .where(eq(agentProfiles.agentId, agentId));
  return generation;
}

export async function assignMemoryVersionProfileGeneration(
  agentId: string,
  memoryVersionId: string,
  generation: number,
  db: AppDbClient = getDb(),
): Promise<void> {
  await db
    .update(agentMemoryVersions)
    .set({ profileGeneration: generation })
    .where(
      and(
        eq(agentMemoryVersions.id, memoryVersionId),
        sql`exists (
          select 1 from agent_memories owner
          where owner.id = ${agentMemoryVersions.memoryId} and owner.agent_id = ${agentId}
        )`,
      ),
    );
}

export async function listActiveTombstones(
  agentId: string,
  db: AppDbClient = getDb(),
): Promise<ProfileTombstone[]> {
  return db
    .select({
      factKey: agentProfileFactTombstones.factKey,
      claimHash: agentProfileFactTombstones.claimHash,
      deletedAt: agentProfileFactTombstones.deletedAt,
      reason: agentProfileFactTombstones.reason,
    })
    .from(agentProfileFactTombstones)
    .where(
      and(
        eq(agentProfileFactTombstones.agentId, agentId),
        isNull(agentProfileFactTombstones.retiredAt),
      ),
    )
    .orderBy(asc(agentProfileFactTombstones.deletedAt), asc(agentProfileFactTombstones.factKey));
}

export async function captureSynthesisSnapshot(agentId: string): Promise<ProfileSynthesisSnapshot> {
  return getDb().transaction(
    async (tx) => {
      await ensureProfileRoot(agentId, tx);
      const [lockedRoot] = await tx
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, agentId))
        .for("update");
      if (!lockedRoot) throw new Error("Profile root disappeared during snapshot.");
      const caughtUp = await assignEligibleNullGenerationsUnderRootLock(
        agentId,
        lockedRoot.dirtyGeneration,
        tx,
      );
      const root = { ...lockedRoot, dirtyGeneration: caughtUp.dirtyGeneration };

      const [currentRow] = root.currentVersionId
        ? await tx
            .select()
            .from(agentProfileVersions)
            .where(
              and(
                eq(agentProfileVersions.id, root.currentVersionId),
                eq(agentProfileVersions.agentId, agentId),
              ),
            )
            .limit(1)
        : [];
      const currentVersion = currentRow ? mapVersion(currentRow) : null;
      const lowerBounds = await readProfileWatermarks(agentId, tx);
      const page = await listGenerationDeltaInputs(
        agentId,
        root.synthesizedGeneration,
        root.dirtyGeneration,
        tx,
      );
      const upperBounds = page.upperBounds;
      const activeMemories = await listActiveProfileMemories(agentId, tx);
      const tombstones = await listActiveTombstones(agentId, tx);
      const currentSources = root.currentVersionId
        ? await listCurrentSourceStates(root.currentVersionId, agentId, tx)
        : [];

      return {
        agentId,
        expectedVersionId: root.currentVersionId,
        expectedVersionNo: currentVersion?.versionNo ?? 0,
        expectedDirtyGeneration: root.dirtyGeneration,
        synthesizedGeneration: root.synthesizedGeneration,
        lowerBounds,
        upperBounds,
        currentVersion,
        currentSources,
        observationDeltas: page.observations,
        memoryVersionDeltas: page.memoryVersions,
        activeMemories,
        tombstones,
        processedGeneration: page.processedGeneration,
        hasMoreEvidence: page.hasMoreEvidence,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

export async function listDeltaInputs(
  agentId: string,
  lower: ProfileWatermarks,
  upper: ProfileWatermarks,
  db: AppDbClient = getDb(),
): Promise<{ observations: ProfileObservationInput[]; memoryVersions: ProfileMemoryInput[] }> {
  const observationConditions = eligibleObservationConditions(agentId);
  observationConditions.push(
    tupleAfter(
      agentGroundedObservations.createdAt,
      agentGroundedObservations.id,
      lower.observation,
    ),
  );
  observationConditions.push(
    tupleAtOrBefore(
      agentGroundedObservations.createdAt,
      agentGroundedObservations.id,
      upper.observation,
    ),
  );

  const observations = await db
    .select({
      id: agentGroundedObservations.id,
      traceEventId: agentGroundedObservations.traceEventId,
      sessionId: agentGroundedObservations.sessionId,
      content: agentGroundedObservations.content,
      createdAt: agentGroundedObservations.createdAt,
      createdAtText: sql<string>`to_char(${agentGroundedObservations.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      profileGeneration: agentGroundedObservations.profileGeneration,
    })
    .from(agentGroundedObservations)
    .innerJoin(agentTraceEvents, eq(agentTraceEvents.id, agentGroundedObservations.traceEventId))
    .leftJoin(agentChatSessions, eq(agentChatSessions.id, agentGroundedObservations.sessionId))
    .where(and(...observationConditions))
    .orderBy(asc(agentGroundedObservations.createdAt), asc(agentGroundedObservations.id));

  const memoryConditions = [
    eq(agentMemories.agentId, agentId),
    inArray(agentMemoryVersions.source, [...ALLOWED_MEMORY_SOURCES]),
    tupleAfter(agentMemoryVersions.createdAt, agentMemoryVersions.id, lower.memoryVersion),
    tupleAtOrBefore(agentMemoryVersions.createdAt, agentMemoryVersions.id, upper.memoryVersion),
  ];
  const memoryRows = await db
    .select({ root: agentMemories, version: agentMemoryVersions })
    .from(agentMemoryVersions)
    .innerJoin(agentMemories, eq(agentMemories.id, agentMemoryVersions.memoryId))
    .where(and(...memoryConditions))
    .orderBy(asc(agentMemoryVersions.createdAt), asc(agentMemoryVersions.id));

  return {
    observations: observations.map((row) => ({
      ...row,
      profileGeneration: Number(row.profileGeneration ?? 0),
    })),
    memoryVersions: memoryRows.map(mapMemoryInput),
  };
}

const PROFILE_EVIDENCE_PAGE_CHARS = 16_000;

async function listGenerationDeltaInputs(
  agentId: string,
  afterGeneration: number,
  throughGeneration: number,
  db: AppDbClient,
): Promise<{
  observations: ProfileObservationInput[];
  memoryVersions: ProfileMemoryInput[];
  processedGeneration: number;
  hasMoreEvidence: boolean;
  upperBounds: ProfileWatermarks;
}> {
  const observationRows = await db
    .select({
      id: agentGroundedObservations.id,
      traceEventId: agentGroundedObservations.traceEventId,
      sessionId: agentGroundedObservations.sessionId,
      content: agentGroundedObservations.content,
      createdAt: agentGroundedObservations.createdAt,
      createdAtText: sql<string>`to_char(${agentGroundedObservations.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      profileGeneration: agentGroundedObservations.profileGeneration,
    })
    .from(agentGroundedObservations)
    .innerJoin(agentTraceEvents, eq(agentTraceEvents.id, agentGroundedObservations.traceEventId))
    .leftJoin(agentChatSessions, eq(agentChatSessions.id, agentGroundedObservations.sessionId))
    .where(
      and(
        ...eligibleObservationConditions(agentId),
        sql`${agentGroundedObservations.profileGeneration} > ${afterGeneration}`,
        sql`${agentGroundedObservations.profileGeneration} <= ${throughGeneration}`,
      ),
    )
    .orderBy(asc(agentGroundedObservations.profileGeneration));
  const memoryRows = await db
    .select({
      root: agentMemories,
      version: agentMemoryVersions,
      createdAtText: sql<string>`to_char(${agentMemoryVersions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(agentMemoryVersions)
    .innerJoin(agentMemories, eq(agentMemories.id, agentMemoryVersions.memoryId))
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        inArray(agentMemoryVersions.source, [...ALLOWED_MEMORY_SOURCES]),
        sql`${agentMemoryVersions.profileGeneration} > ${afterGeneration}`,
        sql`${agentMemoryVersions.profileGeneration} <= ${throughGeneration}`,
      ),
    )
    .orderBy(asc(agentMemoryVersions.profileGeneration));

  const items = [
    ...observationRows.map((row) => ({
      lane: "observation" as const,
      generation: Number(row.profileGeneration),
      row,
    })),
    ...memoryRows.map((row) => ({
      lane: "memory" as const,
      generation: Number(row.version.profileGeneration),
      row,
    })),
  ].sort((a, b) => a.generation - b.generation);
  const selected: typeof items = [];
  let chars = 0;
  for (const item of items) {
    const cost =
      (item.lane === "observation" ? item.row.content : item.row.version.content).length + 500;
    if (selected.length > 0 && chars + cost > PROFILE_EVIDENCE_PAGE_CHARS) break;
    selected.push(item);
    chars += cost;
  }
  const observations = selected.flatMap((item) =>
    item.lane === "observation" ? [{ ...item.row, profileGeneration: item.generation }] : [],
  );
  const memoryVersions = selected.flatMap((item) =>
    item.lane === "memory"
      ? [{ ...mapMemoryInput(item.row), createdAtText: item.row.createdAtText }]
      : [],
  );
  const processedGeneration =
    selected.length < items.length
      ? (selected.at(-1)?.generation ?? afterGeneration)
      : throughGeneration;
  const observationLast = observations.at(-1);
  const memoryLast = memoryVersions.at(-1);
  return {
    observations,
    memoryVersions,
    processedGeneration,
    hasMoreEvidence: selected.length < items.length,
    upperBounds: {
      observation: observationLast
        ? {
            createdAt: observationLast.createdAtText ?? exactTimestamp(observationLast.createdAt),
            id: observationLast.id,
          }
        : { createdAt: null, id: null },
      memoryVersion: memoryLast
        ? {
            createdAt: memoryLast.createdAtText ?? exactTimestamp(memoryLast.createdAt),
            id: memoryLast.memoryVersionId,
          }
        : { createdAt: null, id: null },
    },
  };
}

async function listActiveProfileMemories(
  agentId: string,
  db: AppDbClient,
): Promise<ProfileMemoryInput[]> {
  const rows = await db
    .select({ root: agentMemories, version: agentMemoryVersions })
    .from(agentMemories)
    .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId))
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.scopeType, "agent"),
        eq(agentMemories.scopeId, agentId),
        eq(agentMemories.status, "approved"),
        isNull(agentMemories.revokedAt),
        eq(agentMemories.tombstoned, false),
        eq(agentMemories.injectionBlocked, false),
        inArray(agentMemoryVersions.source, [...ALLOWED_MEMORY_SOURCES]),
        or(
          isNull(agentMemoryVersions.validDuring),
          sql`${agentMemoryVersions.validDuring} @> now()`,
        ),
        or(isNull(agentMemoryVersions.expiresAt), gt(agentMemoryVersions.expiresAt, sql`now()`)),
      ),
    )
    .orderBy(asc(agentMemoryVersions.createdAt), asc(agentMemoryVersions.id));
  return rows.map(mapMemoryInput);
}

async function listCurrentSourceStates(
  profileVersionId: string,
  agentId: string,
  db: AppDbClient,
): Promise<ProfileSourceState[]> {
  const sources = await db
    .select()
    .from(agentProfileVersionSources)
    .where(eq(agentProfileVersionSources.profileVersionId, profileVersionId));
  const traceIds = sources.flatMap((row) => (row.traceEventId ? [row.traceEventId] : []));
  const memoryIds = sources.flatMap((row) => (row.memoryVersionId ? [row.memoryVersionId] : []));
  const traceStates = new Map<string, { live: boolean; occurredAt: Date }>();
  if (traceIds.length) {
    const rows = await db
      .select({
        event: agentTraceEvents,
        observationId: agentGroundedObservations.id,
        observationDeletedAt: agentGroundedObservations.deletedAt,
        sessionOrigin: agentChatSessions.origin,
        sessionDeletedAt: agentChatSessions.deletedAt,
      })
      .from(agentTraceEvents)
      .leftJoin(
        agentGroundedObservations,
        and(
          eq(agentGroundedObservations.traceEventId, agentTraceEvents.id),
          eq(agentGroundedObservations.agentId, agentId),
        ),
      )
      .leftJoin(agentChatSessions, eq(agentChatSessions.id, agentTraceEvents.sessionId))
      .where(and(eq(agentTraceEvents.agentId, agentId), inArray(agentTraceEvents.id, traceIds)));
    for (const row of rows) {
      const directUser =
        row.event.actor === "user" &&
        row.event.trustClass === "user_assertion" &&
        row.event.payload.projectionContaminated !== true;
      const explicit = row.event.eventType === "explicit_memory_write";
      const liveSession =
        row.event.sessionId === null ||
        (row.sessionOrigin === "chat" && row.sessionDeletedAt === null);
      const observationLive =
        explicit || (row.observationId !== null && row.observationDeletedAt === null);
      const previous = traceStates.get(row.event.id);
      traceStates.set(row.event.id, {
        live: (previous?.live ?? false) || (directUser && liveSession && observationLive),
        occurredAt: row.event.occurredAt,
      });
    }
  }
  const memoryStates = new Map<string, { live: boolean; occurredAt: Date }>();
  if (memoryIds.length) {
    const rows = await db
      .select({
        root: agentMemories,
        version: agentMemoryVersions,
        live: sql<boolean>`${agentMemories.currentVersionId} = ${agentMemoryVersions.id}
          and ${agentMemories.status} = 'approved'
          and ${agentMemories.revokedAt} is null
          and ${agentMemories.tombstoned} = false
          and ${agentMemories.injectionBlocked} = false
          and ${agentMemories.scopeType} = 'agent'
          and ${agentMemories.scopeId} = ${agentId}
          and (${agentMemoryVersions.validDuring} is null or ${agentMemoryVersions.validDuring} @> now())
          and (${agentMemoryVersions.expiresAt} is null or ${agentMemoryVersions.expiresAt} > now())`,
      })
      .from(agentMemoryVersions)
      .innerJoin(agentMemories, eq(agentMemories.id, agentMemoryVersions.memoryId))
      .where(and(eq(agentMemories.agentId, agentId), inArray(agentMemoryVersions.id, memoryIds)));
    for (const row of rows) {
      memoryStates.set(row.version.id, {
        live:
          row.live &&
          ALLOWED_MEMORY_SOURCES.includes(
            row.version.source as (typeof ALLOWED_MEMORY_SOURCES)[number],
          ),
        occurredAt: row.version.createdAt,
      });
    }
  }
  return sources.map((source) => {
    const state = source.traceEventId
      ? traceStates.get(source.traceEventId)
      : source.memoryVersionId
        ? memoryStates.get(source.memoryVersionId)
        : undefined;
    return {
      ...mapSource(source),
      live: state?.live ?? false,
      occurredAt: state?.occurredAt ?? null,
    };
  });
}

export type CommitProfileVersionInput = {
  agentId: string;
  expectedVersionId: string | null;
  expectedDirtyGeneration: number;
  facts: ProfileFactV1[];
  sources: ProfileSourceHandle[];
  body: string;
  tokenCount: number;
  trigger: ProfileVersionTrigger;
  authority: ProfileVersionAuthority;
  modelId: string | null;
  promptHash: string;
  policyVersion: string;
  upperBounds?: ProfileWatermarks;
  processedGeneration?: number;
  receipt?: { synthesisKey: string; synthesizerId: string; lowerBounds: ProfileWatermarks };
};

export async function commitProfileVersion(
  input: CommitProfileVersionInput,
  db?: AppDbClient,
): Promise<ProfileSynthesisResult> {
  if (!db) return getDb().transaction((tx) => commitProfileVersion(input, tx));
  validateManifestAndSources(input.facts, input.sources);
  assertMandatoryFactsRenderable(input.facts, getProfileMaxChars(), getProfileTokenBudget());
  const [root] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, input.agentId))
    .for("update");
  if (
    !root ||
    root.currentVersionId !== input.expectedVersionId ||
    root.dirtyGeneration !== input.expectedDirtyGeneration
  ) {
    throw new ProfileGenerationConflictError();
  }
  // Revalidate only after the profile-root lock. Source invalidators take this
  // same lock before mutation, preventing a stale source from becoming current.
  const tombstones = await listActiveTombstones(input.agentId, db);
  const validation = validateProfileCandidate({
    body: input.body,
    facts: input.facts,
    sources: input.sources,
    tombstones,
    maxChars: getProfileMaxChars(),
  });
  if (!validation.valid) {
    throw new ProfileSourceValidationError(
      `Profile candidate failed validation: ${validation.issues.join(", ")}`,
    );
  }
  await validateSourceOwnership(input.agentId, input.sources, db);
  if (input.receipt) {
    const [existing] = await db
      .select({
        profileVersionId: agentProfileSynthesisReceipts.profileVersionId,
        result: agentProfileSynthesisReceipts.result,
      })
      .from(agentProfileSynthesisReceipts)
      .where(
        and(
          eq(agentProfileSynthesisReceipts.agentId, input.agentId),
          eq(agentProfileSynthesisReceipts.synthesisKey, input.receipt.synthesisKey),
          eq(agentProfileSynthesisReceipts.synthesizerId, input.receipt.synthesizerId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.result === "noop") {
        return { result: "noop", profileVersionId: null, versionNo: null };
      }
      const [existingVersion] = await db
        .select({ versionNo: agentProfileVersions.versionNo })
        .from(agentProfileVersions)
        .where(eq(agentProfileVersions.id, existing.profileVersionId as string))
        .limit(1);
      if (!existingVersion)
        throw new Error("Profile synthesis receipt references a missing version.");
      return {
        result: "created",
        profileVersionId: existing.profileVersionId as string,
        versionNo: existingVersion.versionNo,
      };
    }
  }

  const now = new Date();
  if (root.currentVersionId) {
    await db
      .update(agentProfileVersions)
      .set({
        recordedDuring: sql`tstzrange(lower(${agentProfileVersions.recordedDuring}), ${now}, '[)')`,
      })
      .where(eq(agentProfileVersions.id, root.currentVersionId));
  }
  const [version] = await db
    .insert(agentProfileVersions)
    .values({
      agentId: input.agentId,
      versionNo: await nextVersionNo(input.agentId, db),
      body: input.body,
      facts: input.facts,
      trigger: input.trigger,
      authority: input.authority,
      tokenCount: input.tokenCount,
      recordedDuring: sql`tstzrange(${now}, null, '[)')`,
      modelId: input.modelId,
      promptHash: input.promptHash,
      policyVersion: input.policyVersion,
      supersedesProfileVersionId: root.currentVersionId,
    })
    .returning();
  if (!version) throw new Error("Profile version insert failed.");
  if (input.sources.length) {
    await db
      .insert(agentProfileVersionSources)
      .values(input.sources.map((source) => ({ ...source, profileVersionId: version.id })));
  }
  const rootSet: Partial<typeof agentProfiles.$inferInsert> = {
    currentVersionId: version.id,
    updatedAt: now,
  };
  if (input.receipt && input.upperBounds) {
    Object.assign(rootSet, watermarkUpdate(input.upperBounds), {
      synthesizedGeneration: input.processedGeneration ?? input.expectedDirtyGeneration,
      lastSynthesisAttemptAt: now,
      lastSynthesizedAt: now,
      lastSynthesisError: null,
    });
    await db.insert(agentProfileSynthesisReceipts).values({
      agentId: input.agentId,
      synthesisKey: input.receipt.synthesisKey,
      synthesizerId: input.receipt.synthesizerId,
      profileVersionId: version.id,
      inputLowerBounds: serializeWatermarks(input.receipt.lowerBounds),
      inputUpperBounds: serializeWatermarks(input.upperBounds),
      result: "created",
    });
  }
  await db.update(agentProfiles).set(rootSet).where(eq(agentProfiles.agentId, input.agentId));
  return { result: "created", profileVersionId: version.id, versionNo: version.versionNo };
}

export async function commitProfileNoop(
  input: {
    agentId: string;
    expectedVersionId: string | null;
    expectedDirtyGeneration: number;
    lowerBounds: ProfileWatermarks;
    upperBounds: ProfileWatermarks;
    synthesisKey: string;
    synthesizerId: string;
    processedGeneration?: number;
  },
  db?: AppDbClient,
): Promise<ProfileSynthesisResult> {
  if (!db) return getDb().transaction((tx) => commitProfileNoop(input, tx));
  const [root] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, input.agentId))
    .for("update");
  if (
    !root ||
    root.currentVersionId !== input.expectedVersionId ||
    root.dirtyGeneration !== input.expectedDirtyGeneration
  ) {
    throw new ProfileGenerationConflictError();
  }
  await db.insert(agentProfileSynthesisReceipts).values({
    agentId: input.agentId,
    synthesisKey: input.synthesisKey,
    synthesizerId: input.synthesizerId,
    profileVersionId: null,
    inputLowerBounds: serializeWatermarks(input.lowerBounds),
    inputUpperBounds: serializeWatermarks(input.upperBounds),
    result: "noop",
  });
  const now = new Date();
  await db
    .update(agentProfiles)
    .set({
      ...watermarkUpdate(input.upperBounds),
      synthesizedGeneration: input.processedGeneration ?? input.expectedDirtyGeneration,
      lastSynthesisAttemptAt: now,
      lastSynthesizedAt: now,
      lastSynthesisError: null,
      updatedAt: now,
    })
    .where(eq(agentProfiles.agentId, input.agentId));
  return { result: "noop", profileVersionId: null, versionNo: null };
}

export async function getSynthesisReceipt(
  agentId: string,
  synthesisKey: string,
  synthesizerId: string,
  db: AppDbClient = getDb(),
): Promise<ProfileSynthesisResult | null> {
  const [receipt] = await db
    .select({
      result: agentProfileSynthesisReceipts.result,
      profileVersionId: agentProfileSynthesisReceipts.profileVersionId,
    })
    .from(agentProfileSynthesisReceipts)
    .where(
      and(
        eq(agentProfileSynthesisReceipts.agentId, agentId),
        eq(agentProfileSynthesisReceipts.synthesisKey, synthesisKey),
        eq(agentProfileSynthesisReceipts.synthesizerId, synthesizerId),
      ),
    )
    .limit(1);
  if (!receipt) return null;
  if (receipt.result === "noop") return { result: "noop", profileVersionId: null, versionNo: null };
  const [version] = await db
    .select({ versionNo: agentProfileVersions.versionNo })
    .from(agentProfileVersions)
    .where(eq(agentProfileVersions.id, receipt.profileVersionId as string))
    .limit(1);
  if (!version) throw new Error("Profile synthesis receipt references a missing version.");
  return {
    result: "created",
    profileVersionId: receipt.profileVersionId as string,
    versionNo: version.versionNo,
  };
}

export async function recordSynthesisFailure(
  agentId: string,
  error: unknown,
  expected?: { versionId: string | null; dirtyGeneration: number },
  db: AppDbClient = getDb(),
): Promise<void> {
  await ensureProfileRoot(agentId, db);
  await db
    .update(agentProfiles)
    .set({
      lastSynthesisAttemptAt: sql`now()`,
      lastSynthesisError: String(error instanceof Error ? error.message : error).slice(0, 2000),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentProfiles.agentId, agentId),
        ...(expected
          ? [
              expected.versionId === null
                ? isNull(agentProfiles.currentVersionId)
                : eq(agentProfiles.currentVersionId, expected.versionId),
              eq(agentProfiles.dirtyGeneration, expected.dirtyGeneration),
            ]
          : []),
      ),
    );
}

export async function applyDirectiveOverlay(
  input: Omit<
    CommitProfileVersionInput,
    "expectedVersionId" | "expectedDirtyGeneration" | "authority" | "receipt" | "upperBounds"
  > & { allowedReplacementFactKeys?: string[] },
  db: AppDbClient,
): Promise<ProfileSynthesisResult> {
  const { allowedReplacementFactKeys, ...versionInput } = input;
  await ensureProfileRoot(versionInput.agentId, db);
  const [root] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, versionInput.agentId))
    .for("update");
  if (!root) throw new Error("Profile root unavailable for directive overlay.");
  const [current] = root.currentVersionId
    ? await db
        .select({ facts: agentProfileVersions.facts })
        .from(agentProfileVersions)
        .where(eq(agentProfileVersions.id, root.currentVersionId))
        .limit(1)
    : [];
  const overlayValidation = validateProfileCandidate({
    body: versionInput.body,
    facts: versionInput.facts,
    sources: versionInput.sources,
    previousFacts: current?.facts,
    allowedReplacementFactKeys,
    tombstones: await listActiveTombstones(versionInput.agentId, db),
    maxChars: getProfileMaxChars(),
  });
  if (!overlayValidation.valid) {
    throw new ProfileSourceValidationError(
      `Directive overlay failed validation: ${overlayValidation.issues.join(", ")}`,
    );
  }
  const [dirty] = await db
    .update(agentProfiles)
    .set({ dirtyGeneration: sql`${agentProfiles.dirtyGeneration} + 1`, updatedAt: sql`now()` })
    .where(eq(agentProfiles.agentId, versionInput.agentId))
    .returning({ dirtyGeneration: agentProfiles.dirtyGeneration });
  return commitProfileVersion(
    {
      ...versionInput,
      authority: "user",
      expectedVersionId: root.currentVersionId,
      expectedDirtyGeneration: dirty?.dirtyGeneration ?? root.dirtyGeneration + 1,
    },
    db,
  );
}

async function validateSourceOwnership(
  agentId: string,
  sources: ProfileSourceHandle[],
  db: AppDbClient,
): Promise<void> {
  const traceIds = [
    ...new Set(sources.flatMap((source) => (source.traceEventId ? [source.traceEventId] : []))),
  ];
  const memoryIds = [
    ...new Set(
      sources.flatMap((source) => (source.memoryVersionId ? [source.memoryVersionId] : [])),
    ),
  ];
  if (traceIds.length) {
    const rows = await db
      .select({ id: agentTraceEvents.id })
      .from(agentTraceEvents)
      .leftJoin(
        agentGroundedObservations,
        and(
          eq(agentGroundedObservations.traceEventId, agentTraceEvents.id),
          eq(agentGroundedObservations.agentId, agentId),
        ),
      )
      .leftJoin(agentChatSessions, eq(agentChatSessions.id, agentGroundedObservations.sessionId))
      .where(
        and(
          eq(agentTraceEvents.agentId, agentId),
          eq(agentTraceEvents.actor, "user"),
          eq(agentTraceEvents.trustClass, "user_assertion"),
          sql`coalesce(${agentTraceEvents.payload}->>'projectionContaminated', 'false') <> 'true'`,
          inArray(agentTraceEvents.id, traceIds),
          or(
            eq(agentTraceEvents.eventType, "explicit_memory_write"),
            and(
              sql`${agentGroundedObservations.id} is not null`,
              isNull(agentGroundedObservations.deletedAt),
              or(
                and(
                  eq(agentGroundedObservations.originKind, "memory_user"),
                  isNull(agentGroundedObservations.sessionId),
                ),
                and(
                  eq(agentGroundedObservations.originKind, "chat_user"),
                  eq(agentChatSessions.agentId, agentId),
                  eq(agentChatSessions.origin, "chat"),
                  isNull(agentChatSessions.deletedAt),
                ),
              ),
            ),
          ),
        ),
      );
    if (new Set(rows.map((row) => row.id)).size !== traceIds.length) {
      throw new ProfileSourceValidationError(
        "A trace source is not direct user evidence for this agent.",
      );
    }
  }
  if (memoryIds.length) {
    const rows = await db
      .select({ id: agentMemoryVersions.id })
      .from(agentMemoryVersions)
      .innerJoin(agentMemories, eq(agentMemories.id, agentMemoryVersions.memoryId))
      .innerJoin(
        agentMemoryVersionTraceEvents,
        eq(agentMemoryVersionTraceEvents.memoryVersionId, agentMemoryVersions.id),
      )
      .where(
        and(
          eq(agentMemories.agentId, agentId),
          eq(agentMemories.scopeType, "agent"),
          eq(agentMemories.scopeId, agentId),
          eq(agentMemories.status, "approved"),
          isNull(agentMemories.revokedAt),
          eq(agentMemories.tombstoned, false),
          eq(agentMemories.injectionBlocked, false),
          sql`${agentMemories.currentVersionId} = ${agentMemoryVersions.id}`,
          inArray(agentMemoryVersions.source, [...ALLOWED_MEMORY_SOURCES]),
          or(
            isNull(agentMemoryVersions.validDuring),
            sql`${agentMemoryVersions.validDuring} @> now()`,
          ),
          or(isNull(agentMemoryVersions.expiresAt), gt(agentMemoryVersions.expiresAt, sql`now()`)),
          inArray(agentMemoryVersions.id, memoryIds),
        ),
      );
    if (new Set(rows.map((row) => row.id)).size !== memoryIds.length) {
      throw new ProfileSourceValidationError(
        "A memory source is out of scope, unsupported, or lacks trace provenance.",
      );
    }
  }
}

function validateManifestAndSources(facts: ProfileFactV1[], sources: ProfileSourceHandle[]): void {
  const keys = new Set<string>();
  for (const fact of facts) {
    if (!fact.factKey || keys.has(fact.factKey))
      throw new ProfileSourceValidationError("Profile fact keys must be unique and non-empty.");
    keys.add(fact.factKey);
  }
  const sourced = new Set<string>();
  for (const source of sources) {
    if (!keys.has(source.factKey))
      throw new ProfileSourceValidationError("A profile source names a missing fact.");
    if ((source.traceEventId === null) === (source.memoryVersionId === null)) {
      throw new ProfileSourceValidationError(
        "A profile source must use exactly one provenance lane.",
      );
    }
    sourced.add(source.factKey);
  }
  for (const key of keys) {
    if (!sourced.has(key))
      throw new ProfileSourceValidationError(`Profile fact '${key}' has no provenance.`);
  }
}

function mapVersion(row: typeof agentProfileVersions.$inferSelect): ProfileVersion {
  return {
    id: row.id,
    agentId: row.agentId,
    versionNo: row.versionNo,
    body: row.body,
    facts: row.facts,
    trigger: row.trigger,
    authority: row.authority,
    charCount: row.charCount ?? [...row.body].length,
    tokenCount: row.tokenCount,
    modelId: row.modelId,
    promptHash: row.promptHash,
    schemaVersion: row.schemaVersion,
    policyVersion: row.policyVersion,
    createdAt: row.createdAt,
    supersedesProfileVersionId: row.supersedesProfileVersionId,
  };
}

function mapSource(row: typeof agentProfileVersionSources.$inferSelect): ProfileSourceHandle {
  return {
    factKey: row.factKey,
    sourceRole: row.sourceRole,
    traceEventId: row.traceEventId,
    memoryVersionId: row.memoryVersionId,
  };
}

function mapMemoryInput(row: {
  root: typeof agentMemories.$inferSelect;
  version: typeof agentMemoryVersions.$inferSelect;
}): ProfileMemoryInput {
  const now = new Date();
  return {
    memoryId: row.root.id,
    memoryVersionId: row.version.id,
    content: row.version.content,
    source: row.version.source,
    authority: row.version.authority,
    protected: row.root.isProtected,
    active:
      row.root.currentVersionId === row.version.id &&
      row.root.status === "approved" &&
      row.root.revokedAt === null &&
      !row.root.tombstoned &&
      !row.root.injectionBlocked &&
      (row.version.expiresAt === null || row.version.expiresAt > now),
    createdAt: row.version.createdAt,
    createdAtText: exactTimestamp(row.version.createdAt),
    profileGeneration: row.version.profileGeneration,
    expiresAt: row.version.expiresAt,
  };
}

function exactTimestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, (fraction) => `${fraction.slice(0, -1)}000Z`);
}

async function readProfileWatermarks(agentId: string, db: AppDbClient): Promise<ProfileWatermarks> {
  const [row] = await db
    .select({
      observationCreatedAt: sql<string | null>`${agentProfiles.lastObservationCreatedAt}::text`,
      observationId: agentProfiles.lastObservationId,
      memoryCreatedAt: sql<string | null>`${agentProfiles.lastMemoryVersionCreatedAt}::text`,
      memoryId: agentProfiles.lastMemoryVersionId,
    })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .limit(1);
  return {
    observation: {
      createdAt: row?.observationCreatedAt ?? null,
      id: row?.observationId ?? null,
    },
    memoryVersion: {
      createdAt: row?.memoryCreatedAt ?? null,
      id: row?.memoryId ?? null,
    },
  };
}

function watermarkUpdate(bounds: ProfileWatermarks) {
  return {
    lastObservationCreatedAt: bounds.observation.createdAt
      ? sql`${bounds.observation.createdAt}::timestamptz`
      : null,
    lastObservationId: bounds.observation.id,
    lastMemoryVersionCreatedAt: bounds.memoryVersion.createdAt
      ? sql`${bounds.memoryVersion.createdAt}::timestamptz`
      : null,
    lastMemoryVersionId: bounds.memoryVersion.id,
  };
}

function serializeWatermarks(bounds: ProfileWatermarks): Record<string, unknown> {
  return {
    observation: bounds.observation,
    memoryVersion: bounds.memoryVersion,
  };
}

function tupleAfter(
  createdAt: typeof agentGroundedObservations.createdAt | typeof agentMemoryVersions.createdAt,
  id: typeof agentGroundedObservations.id | typeof agentMemoryVersions.id,
  tuple: ProfileTuple,
) {
  if (!tuple.createdAt || !tuple.id) return sql`true`;
  return sql`(${createdAt}, ${id}) > (${tuple.createdAt}::timestamptz, ${tuple.id})`;
}

function tupleAtOrBefore(
  createdAt: typeof agentGroundedObservations.createdAt | typeof agentMemoryVersions.createdAt,
  id: typeof agentGroundedObservations.id | typeof agentMemoryVersions.id,
  tuple: ProfileTuple,
) {
  if (!tuple.createdAt || !tuple.id) return sql`false`;
  return sql`(${createdAt}, ${id}) <= (${tuple.createdAt}::timestamptz, ${tuple.id})`;
}

async function nextVersionNo(agentId: string, db: AppDbClient): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${agentProfileVersions.versionNo}), 0)` })
    .from(agentProfileVersions)
    .where(eq(agentProfileVersions.agentId, agentId));
  return Number(row?.max ?? 0) + 1;
}
