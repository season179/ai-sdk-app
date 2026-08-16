import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  agentChatSessions,
  agentMemories,
  agentMemoryVersions,
  agentProfileFactTombstones,
  agentProfiles,
  agentProfileVersions,
  agentTraceEvents,
} from "@/db/schema";
import { getMemoryPolicyVersion } from "@/lib/memory/config";
import {
  detectPromptInjection,
  detectSecret,
  redactText,
  sanitizeTracePayload,
  sha256,
} from "@/lib/memory/redaction";
import { appendTraceEvents } from "@/lib/memory/trace";
import {
  getProfileMaxChars,
  getProfilePolicyVersion,
  isProfileEnabled,
  isProfileExplicitWriteEnabled,
  isProfileSynthesisEnabled,
} from "@/lib/profile/config";
import { enqueueProfileSynthesis } from "@/lib/profile/jobs";
import { normalizeStableFactKey } from "@/lib/profile/reconcile";
import {
  applyDirectiveOverlay,
  ensureProfileRoot,
  listActiveTombstones,
  listProfileVersionSources,
  markProfileDirty,
} from "@/lib/profile/repository";
import type { ProfileFactCategory, ProfileFactV1, ProfileSourceHandle } from "@/lib/profile/types";
import {
  countProfileCharacters,
  isCompleteSentence,
  validateProfileCandidate,
} from "@/lib/profile/validate";
import { archiveMemory, setMemoryProtection } from "@/lib/self-improvement/memories";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";
import { isUuid } from "@/lib/utils";

const HEADING_TO_CATEGORY: Readonly<Record<string, ProfileFactCategory>> = {
  "identity and context": "identity_context",
  "preferences and constraints": "preferences_constraints",
  "active projects and goals": "active_projects_goals",
  "interaction instructions": "interaction_instructions",
};
const HEADING_PATTERN =
  /^\s*#{0,6}\s*(Identity and context|Preferences and constraints|Active projects and goals|Interaction instructions)\s*:?\s*#*\s*$/i;
const UI_PROMPT_VERSION = "profile-manual-ui-v1";

export class ProfileServiceInputError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ProfileServiceInputError";
    this.issues = issues;
  }
}

export class ProfileServiceConflictError extends Error {
  constructor(message = "The profile changed. Reload it before trying again.") {
    super(message);
    this.name = "ProfileServiceConflictError";
  }
}

export class ProfileFactNotFoundError extends Error {
  constructor(factKey: string) {
    super(`No active profile fact with key '${factKey}' was found.`);
    this.name = "ProfileFactNotFoundError";
  }
}

export class ProfileServiceDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileServiceDisabledError";
  }
}

export type ProfileSourceSession = {
  sessionId: string;
  title: string | null;
  href: string;
};

export type ProfileControlPlaneFact = ProfileFactV1 & {
  sourceCount: number;
  sourceSessions: ProfileSourceSession[];
};

export type ProfileControlPlaneDto = {
  body: string;
  maxChars: number;
  version: {
    id: string;
    versionNo: number;
    trigger: "scheduled" | "explicit" | "manual_ui";
    authority: "synthesized" | "user";
    modelId: string | null;
    policyVersion: string;
    createdAt: string;
    charCount: number;
    tokenCount: number;
  } | null;
  facts: ProfileControlPlaneFact[];
  dirtyGeneration: number;
  synthesizedGeneration: number;
  dirty: boolean;
  lastSynthesisAttemptAt: string | null;
  lastSynthesizedAt: string | null;
  lastSynthesisError: string | null;
};

type ParsedProfileSentence = {
  sentence: string;
  category: ProfileFactCategory;
};

export function assertProfileReadAvailable(): void {
  if (!isProfileEnabled() && !isProfileSynthesisEnabled()) {
    throw new ProfileServiceDisabledError(
      "Agent profiles are disabled (enable AGENT_PROFILE_ENABLED or AGENT_PROFILE_SYNTHESIS_ENABLED).",
    );
  }
}

export function assertProfileWritesAvailable(): void {
  if (!isProfileExplicitWriteEnabled()) {
    throw new ProfileServiceDisabledError(
      "Profile writes are disabled (AGENT_PROFILE_EXPLICIT_WRITE_ENABLED=false).",
    );
  }
}

export function normalizeManualProfileBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProfileServiceInputError("Profile body must be a string.");
  }
  return value.replace(/\r\n?/g, "\n").trimEnd();
}

/** Deterministic, strict parsing: only the four stable headings and complete sentences survive. */
export function segmentManualProfileBody(body: string): ParsedProfileSentence[] {
  if (!body) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const parsed: ParsedProfileSentence[] = [];
  let category: ProfileFactCategory = "identity_context";
  let activeHeadingLine: number | null = null;
  let activeHeadingHasSentence = false;

  for (const [lineIndex, line] of body.split("\n").entries()) {
    if (!line.trim()) continue;
    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      if (activeHeadingLine !== null && !activeHeadingHasSentence) {
        throw new ProfileServiceInputError(
          `Profile heading on line ${activeHeadingLine} has no sentences.`,
          ["empty_heading"],
        );
      }
      category = HEADING_TO_CATEGORY[heading[1].toLocaleLowerCase("en-US")];
      activeHeadingLine = lineIndex + 1;
      activeHeadingHasSentence = false;
      continue;
    }
    for (const segment of segmenter.segment(line)) {
      const sentence = segment.segment.trim();
      if (!sentence) continue;
      if (!isCompleteSentence(sentence)) {
        throw new ProfileServiceInputError(
          `Profile text contains an incomplete sentence on line ${lineIndex + 1}.`,
          ["incomplete_sentence"],
        );
      }
      parsed.push({ sentence, category });
      activeHeadingHasSentence = true;
    }
  }
  if (activeHeadingLine !== null && !activeHeadingHasSentence) {
    throw new ProfileServiceInputError(
      `Profile heading on line ${activeHeadingLine} has no sentences.`,
      ["empty_heading"],
    );
  }

  const seen = new Set<string>();
  for (const fact of parsed) {
    if (seen.has(fact.sentence)) {
      throw new ProfileServiceInputError("Each profile sentence must appear exactly once.", [
        "duplicate_sentence",
      ]);
    }
    seen.add(fact.sentence);
  }
  return parsed;
}

export async function getProfileControlPlane(
  agentId = DEFAULT_AGENT_ID,
  db?: AppDbClient,
): Promise<ProfileControlPlaneDto> {
  assertProfileReadAvailable();
  return readProfileControlPlane(agentId, db ?? getDb());
}

async function readProfileControlPlane(
  agentId: string,
  db: AppDbClient = getDb(),
): Promise<ProfileControlPlaneDto> {
  const [root] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .limit(1);
  const [version] = root?.currentVersionId
    ? await db
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
  const sources = version ? await listProfileVersionSources(version.id, agentId, db) : [];
  const sessionsByFact = version
    ? await listSourceSessions(agentId, sources, db)
    : new Map<string, ProfileSourceSession[]>();
  const sourceCounts = new Map<string, number>();
  for (const source of sources) {
    sourceCounts.set(source.factKey, (sourceCounts.get(source.factKey) ?? 0) + 1);
  }
  const facts = [...(version?.facts ?? [])]
    .sort((a, b) => a.order - b.order || a.factKey.localeCompare(b.factKey))
    .map((fact) => ({
      ...fact,
      sourceCount: sourceCounts.get(fact.factKey) ?? 0,
      sourceSessions: sessionsByFact.get(fact.factKey) ?? [],
    }));
  const dirtyGeneration = root?.dirtyGeneration ?? 0;
  const synthesizedGeneration = root?.synthesizedGeneration ?? 0;

  return {
    body: version?.body ?? "",
    maxChars: getProfileMaxChars(),
    version: version
      ? {
          id: version.id,
          versionNo: version.versionNo,
          trigger: version.trigger,
          authority: version.authority,
          modelId: version.modelId,
          policyVersion: version.policyVersion,
          createdAt: version.createdAt.toISOString(),
          charCount: version.charCount ?? countProfileCharacters(version.body),
          tokenCount: version.tokenCount,
        }
      : null,
    facts,
    dirtyGeneration,
    synthesizedGeneration,
    dirty: dirtyGeneration > synthesizedGeneration,
    lastSynthesisAttemptAt: root?.lastSynthesisAttemptAt?.toISOString() ?? null,
    lastSynthesizedAt: root?.lastSynthesizedAt?.toISOString() ?? null,
    lastSynthesisError: publicSynthesisError(root?.lastSynthesisError ?? null),
  };
}

export async function saveManualProfile(
  input: { body: unknown; expectedVersionId: unknown },
  agentId = DEFAULT_AGENT_ID,
): Promise<{ profile: ProfileControlPlaneDto; jobId: string | null }> {
  assertProfileWritesAvailable();
  const body = normalizeManualProfileBody(input.body);
  assertSafeManualBody(body);
  const expectedVersionId = parseExpectedVersionId(input.expectedVersionId, true);
  const parsed = segmentManualProfileBody(body);

  await getDb().transaction(async (tx) => {
    await ensureProfileRoot(agentId, tx);
    const [root] = await tx
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId))
      .for("update");
    if (!root) throw new Error("Profile root unavailable.");
    if (root.currentVersionId !== expectedVersionId) throw new ProfileServiceConflictError();

    const [current] = root.currentVersionId
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
    const currentFacts = current?.facts ?? [];
    const currentSources = current ? await listProfileVersionSources(current.id, agentId, tx) : [];
    const auditEventId = await appendUiAuditEvent(
      agentId,
      "save",
      {
        expectedVersionId,
        priorVersionId: root.currentVersionId,
        bodyHash: sha256(body),
        sentenceCount: parsed.length,
      },
      tx,
    );
    const activeTombstones = new Set(
      (await listActiveTombstones(agentId, tx)).map((row) => row.factKey),
    );
    const currentBySentence = new Map(currentFacts.map((fact) => [fact.sentence, fact]));
    const usedKeys = new Set(currentFacts.map((fact) => fact.factKey));
    const retainedKeys = new Set<string>();
    const facts: ProfileFactV1[] = [];
    const sources: ProfileSourceHandle[] = [];

    parsed.forEach((next, order) => {
      const existing = currentBySentence.get(next.sentence);
      if (existing) {
        retainedKeys.add(existing.factKey);
        facts.push({ ...existing, category: next.category, order });
        sources.push(
          ...currentSources
            .filter((source) => source.factKey === existing.factKey)
            .map((source) => ({ ...source })),
        );
        if (existing.category !== next.category) {
          sources.push(uiSource(existing.factKey, auditEventId));
        }
        return;
      }
      const factKey = allocateUiFactKey(
        next.sentence,
        next.category,
        usedKeys,
        activeTombstones,
        auditEventId,
        order,
      );
      usedKeys.add(factKey);
      retainedKeys.add(factKey);
      facts.push({
        factKey,
        sentence: next.sentence,
        category: next.category,
        authority: "user",
        protected: false,
        order,
      });
      sources.push(uiSource(factKey, auditEventId));
    });

    const removedKeys = currentFacts
      .map((fact) => fact.factKey)
      .filter((factKey) => !retainedKeys.has(factKey));
    await upsertActiveTombstones(agentId, removedKeys, auditEventId, "manual_ui_omission", tx);
    validateManualCandidate(body, facts, sources, currentFacts, removedKeys);
    await applyDirectiveOverlay(
      {
        agentId,
        facts,
        sources: dedupeSources(sources),
        body,
        tokenCount: estimateTokenCount(body),
        trigger: "manual_ui",
        modelId: null,
        promptHash: sha256(`${UI_PROMPT_VERSION}\n${body}`),
        policyVersion: getProfilePolicyVersion(),
        allowedReplacementFactKeys: [],
      },
      tx,
    );
  });

  const jobId = await enqueueManualPolish(agentId);
  return { profile: await readProfileControlPlane(agentId), jobId };
}

export async function deleteManualProfileFact(
  factKey: string,
  input: { expectedVersionId?: unknown } = {},
  agentId = DEFAULT_AGENT_ID,
): Promise<{ profile: ProfileControlPlaneDto; jobId: string | null }> {
  assertProfileWritesAvailable();
  if (
    !factKey ||
    factKey.length > 200 ||
    [...factKey].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new ProfileServiceInputError("Fact key is invalid.");
  }
  const hasExpected = Object.hasOwn(input, "expectedVersionId");
  const expectedVersionId = parseExpectedVersionId(input.expectedVersionId, hasExpected);

  await getDb().transaction(async (tx) => {
    await ensureProfileRoot(agentId, tx);
    const [root] = await tx
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId))
      .for("update");
    if (!root) throw new Error("Profile root unavailable.");
    if (hasExpected && root.currentVersionId !== expectedVersionId) {
      throw new ProfileServiceConflictError();
    }
    if (!root.currentVersionId) throw new ProfileFactNotFoundError(factKey);
    const [current] = await tx
      .select()
      .from(agentProfileVersions)
      .where(
        and(
          eq(agentProfileVersions.id, root.currentVersionId),
          eq(agentProfileVersions.agentId, agentId),
        ),
      )
      .limit(1);
    const target = current?.facts.find((fact) => fact.factKey === factKey);
    if (!current || !target) throw new ProfileFactNotFoundError(factKey);
    const currentSources = await listProfileVersionSources(current.id, agentId, tx);
    const auditEventId = await appendUiAuditEvent(
      agentId,
      "delete",
      { expectedVersionId: hasExpected ? expectedVersionId : undefined, factKey },
      tx,
    );
    await upsertActiveTombstones(agentId, [factKey], auditEventId, "manual_ui_delete", tx);
    await archiveBackingUserMemories(agentId, factKey, currentSources, auditEventId, tx);

    const facts = current.facts
      .filter((fact) => fact.factKey !== factKey)
      .map((fact, order) => ({ ...fact, order }));
    const kept = new Set(facts.map((fact) => fact.factKey));
    const sources = currentSources.filter((source) => kept.has(source.factKey));
    const body = removeFactSentence(current.body, target.sentence);
    validateManualCandidate(body, facts, sources, current.facts, [factKey]);
    await applyDirectiveOverlay(
      {
        agentId,
        facts,
        sources,
        body,
        tokenCount: estimateTokenCount(body),
        trigger: "manual_ui",
        modelId: null,
        promptHash: sha256(`${UI_PROMPT_VERSION}\ndelete:${factKey}\n${body}`),
        policyVersion: getProfilePolicyVersion(),
        allowedReplacementFactKeys: [],
      },
      tx,
    );
  });

  const jobId = await enqueueManualPolish(agentId);
  return { profile: await readProfileControlPlane(agentId), jobId };
}

export async function requestManualProfileSynthesis(
  agentId = DEFAULT_AGENT_ID,
): Promise<{ jobId: string | null; dirtyGeneration: number; dirty: true }> {
  assertProfileWritesAvailable();
  if (!isProfileSynthesisEnabled()) {
    throw new ProfileServiceDisabledError(
      "Profile synthesis is disabled (AGENT_PROFILE_SYNTHESIS_ENABLED=false).",
    );
  }
  const dirtyGeneration = await markProfileDirty(agentId);
  let jobId: string | null = null;
  try {
    jobId = await enqueueProfileSynthesis(agentId, { trigger: "manual_ui" });
  } catch (error) {
    console.error("Enqueuing manual profile synthesis failed; profile remains dirty", error);
  }
  return { jobId, dirtyGeneration, dirty: true };
}

function publicSynthesisError(value: string | null): string | null {
  if (!value) return null;
  const redacted = redactText(value).text.split(/\r?\n/u, 1)[0].trim();
  if (!redacted || /prompt|evidence|payload|request\s*body|provider\s*response/i.test(redacted)) {
    return "Profile synthesis failed. Retry now or inspect server logs.";
  }
  return Array.from(redacted).slice(0, 500).join("");
}

function assertSafeManualBody(body: string): void {
  const redacted = redactText(body);
  if (detectSecret(body) || redacted.secretDetected || redacted.text !== body) {
    throw new ProfileServiceInputError("Profile text cannot contain secrets.", ["secret_detected"]);
  }
  if (detectPromptInjection(body)) {
    throw new ProfileServiceInputError(
      "Profile text cannot contain instruction or permission overrides.",
      ["prompt_injection_detected"],
    );
  }
  if (countProfileCharacters(body) > getProfileMaxChars()) {
    throw new ProfileServiceInputError(
      `Profile text exceeds the ${getProfileMaxChars()} character limit.`,
      ["body_over_character_cap"],
    );
  }
}

function parseExpectedVersionId(value: unknown, required: boolean): string | null {
  if (!required && value === undefined) return null;
  if (value === null) return null;
  if (typeof value !== "string" || !isUuid(value)) {
    throw new ProfileServiceInputError(
      required
        ? "expectedVersionId must be a UUID or null."
        : "expectedVersionId must be a UUID when provided.",
    );
  }
  return value;
}

function validateManualCandidate(
  body: string,
  facts: ProfileFactV1[],
  sources: ProfileSourceHandle[],
  previousFacts: ProfileFactV1[],
  removedKeys: string[],
): void {
  const validation = validateProfileCandidate({
    body,
    facts,
    sources,
    previousFacts,
    tombstones: removedKeys,
    maxChars: getProfileMaxChars(),
  });
  if (!validation.valid) {
    throw new ProfileServiceInputError("Profile text is invalid.", validation.issues);
  }
}

async function appendUiAuditEvent(
  agentId: string,
  operation: "save" | "delete",
  payload: Record<string, unknown>,
  db: AppDbClient,
): Promise<string> {
  const traceId = `profile-ui:${randomUUID()}`;
  const sanitized = sanitizeTracePayload({ operation, surface: "profile_ui", ...payload });
  const [event] = await appendTraceEvents(
    [
      {
        agentId,
        traceId,
        sequenceNo: 0,
        eventType: "explicit_memory_write",
        actor: "user",
        trustClass: "user_assertion",
        sensitivityClass: sanitized.sensitivityClass,
        payload: sanitized.payload,
        artifact: sanitized.artifact,
        contentHash: sanitized.contentHash,
        idempotencyKey: traceId,
        retentionClass: "audit",
        policyVersion: getMemoryPolicyVersion(),
        occurredAt: new Date(),
      },
    ],
    db,
  );
  if (!event) throw new Error("Profile UI audit event was not recorded.");
  return event.id;
}

async function upsertActiveTombstones(
  agentId: string,
  factKeys: string[],
  eventId: string,
  reason: string,
  db: AppDbClient,
): Promise<void> {
  for (const factKey of factKeys) {
    await db
      .insert(agentProfileFactTombstones)
      .values({
        agentId,
        factKey,
        deletedBy: "manual_ui",
        reason,
        explicitTraceEventId: eventId,
      })
      .onConflictDoUpdate({
        target: [agentProfileFactTombstones.agentId, agentProfileFactTombstones.factKey],
        set: {
          deletedAt: sql`now()`,
          deletedBy: "manual_ui",
          reason,
          explicitTraceEventId: eventId,
          retiredAt: null,
          retiredBy: null,
          retiredTraceEventId: null,
        },
      });
  }
}

function uiSource(factKey: string, auditEventId: string): ProfileSourceHandle {
  return {
    factKey,
    sourceRole: "primary",
    traceEventId: auditEventId,
    memoryVersionId: null,
  };
}

function allocateUiFactKey(
  sentence: string,
  category: ProfileFactCategory,
  usedKeys: ReadonlySet<string>,
  tombstones: ReadonlySet<string>,
  auditEventId: string,
  order: number,
): string {
  const base = normalizeStableFactKey(`${category}-${sentence}`);
  if (!usedKeys.has(base) && !tombstones.has(base)) return base;
  return `${base.slice(0, 166)}-ui-${sha256(`${auditEventId}:${order}:${sentence}`).slice(0, 24)}`;
}

function dedupeSources(sources: ProfileSourceHandle[]): ProfileSourceHandle[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.factKey}:${source.sourceRole}:${source.traceEventId ?? ""}:${source.memoryVersionId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function estimateTokenCount(body: string): number {
  return body ? Math.ceil(countProfileCharacters(body) / 4) : 0;
}

function removeFactSentence(body: string, sentence: string): string {
  const index = body.indexOf(sentence);
  if (index < 0) throw new ProfileServiceInputError("The profile body does not contain the fact.");
  const next = `${body.slice(0, index)}${body.slice(index + sentence.length)}`
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return stripEmptyProfileHeadings(next);
}

function stripEmptyProfileHeadings(body: string): string {
  const lines = body.split("\n");
  const keep = lines.map(() => true);
  for (const [index, line] of lines.entries()) {
    if (!HEADING_PATTERN.test(line)) continue;
    let hasSentence = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (HEADING_PATTERN.test(lines[cursor])) break;
      if (lines[cursor].trim()) {
        hasSentence = true;
        break;
      }
    }
    if (!hasSentence) keep[index] = false;
  }
  return lines
    .filter((_, index) => keep[index])
    .join("\n")
    .replace(/^\s*\n+/u, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

async function archiveBackingUserMemories(
  agentId: string,
  factKey: string,
  currentSources: ProfileSourceHandle[],
  auditEventId: string,
  db: AppDbClient,
): Promise<void> {
  const sourceVersionIds = currentSources.flatMap((source) =>
    source.factKey === factKey && source.memoryVersionId ? [source.memoryVersionId] : [],
  );
  const conditions = [
    eq(agentMemories.agentId, agentId),
    eq(agentMemories.scopeType, "agent"),
    eq(agentMemories.scopeId, agentId),
    eq(agentMemories.status, "approved"),
    isNull(agentMemories.revokedAt),
    eq(agentMemories.tombstoned, false),
    eq(agentMemoryVersions.source, "user"),
    sql`${agentMemories.currentVersionId} = ${agentMemoryVersions.id}`,
  ];
  const match = sourceVersionIds.length
    ? or(
        inArray(agentMemoryVersions.id, sourceVersionIds),
        sql`${agentMemoryVersions.structured}->'profileDirective'->>'factKey' = ${factKey}`,
      )
    : sql`${agentMemoryVersions.structured}->'profileDirective'->>'factKey' = ${factKey}`;
  const rows = await db
    .select({ id: agentMemories.id, isProtected: agentMemories.isProtected })
    .from(agentMemories)
    .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId))
    .where(and(...conditions, match));
  for (const memory of rows) {
    if (memory.isProtected) {
      await setMemoryProtection(memory.id, false, agentId, undefined, db);
    }
    await archiveMemory(memory.id, agentId, db, [auditEventId]);
  }
}

async function enqueueManualPolish(agentId: string): Promise<string | null> {
  if (!isProfileSynthesisEnabled()) return null;
  try {
    return await enqueueProfileSynthesis(agentId, { trigger: "manual_ui" });
  } catch (error) {
    console.error("Enqueuing profile polish failed; saved profile remains dirty", error);
    return null;
  }
}

async function listSourceSessions(
  agentId: string,
  sources: ProfileSourceHandle[],
  db: AppDbClient,
): Promise<Map<string, ProfileSourceSession[]>> {
  const traceIds = [
    ...new Set(sources.flatMap((source) => (source.traceEventId ? [source.traceEventId] : []))),
  ];
  const memoryVersionIds = [
    ...new Set(
      sources.flatMap((source) => (source.memoryVersionId ? [source.memoryVersionId] : [])),
    ),
  ];
  const traceSessions = traceIds.length
    ? await db
        .select({
          sourceId: agentTraceEvents.id,
          sessionId: agentChatSessions.id,
          title: agentChatSessions.title,
        })
        .from(agentTraceEvents)
        .innerJoin(agentChatSessions, eq(agentChatSessions.id, agentTraceEvents.sessionId))
        .where(
          and(
            eq(agentTraceEvents.agentId, agentId),
            eq(agentChatSessions.agentId, agentId),
            eq(agentChatSessions.origin, "chat"),
            isNull(agentChatSessions.deletedAt),
            inArray(agentTraceEvents.id, traceIds),
          ),
        )
    : [];
  const memorySessions = memoryVersionIds.length
    ? await db
        .select({
          sourceId: agentMemoryVersions.id,
          sessionId: agentChatSessions.id,
          title: agentChatSessions.title,
        })
        .from(agentMemoryVersions)
        .innerJoin(agentMemories, eq(agentMemories.id, agentMemoryVersions.memoryId))
        .innerJoin(agentChatSessions, eq(agentChatSessions.id, agentMemories.sessionId))
        .where(
          and(
            eq(agentMemories.agentId, agentId),
            eq(agentChatSessions.agentId, agentId),
            eq(agentChatSessions.origin, "chat"),
            isNull(agentChatSessions.deletedAt),
            inArray(agentMemoryVersions.id, memoryVersionIds),
          ),
        )
    : [];
  const traceById = new Map(traceSessions.map((row) => [row.sourceId, row]));
  const memoryById = new Map(memorySessions.map((row) => [row.sourceId, row]));
  const result = new Map<string, ProfileSourceSession[]>();
  const seen = new Set<string>();
  for (const source of sources) {
    const row = source.traceEventId
      ? traceById.get(source.traceEventId)
      : source.memoryVersionId
        ? memoryById.get(source.memoryVersionId)
        : undefined;
    if (!row) continue;
    const key = `${source.factKey}:${row.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const links = result.get(source.factKey) ?? [];
    links.push({ sessionId: row.sessionId, title: row.title, href: `/?c=${row.sessionId}` });
    result.set(source.factKey, links);
  }
  return result;
}
