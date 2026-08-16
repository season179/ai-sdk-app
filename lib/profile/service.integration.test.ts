import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  agentChatSessions,
  agentProfileFactTombstones,
  agentProfileVersionSources,
  agentTraceEvents,
} from "@/db/schema";
import { appendTraceEvents } from "@/lib/memory/trace";
import { ProfileMandatoryFactsOverBudgetError } from "@/lib/profile/render";
import { applyDirectiveOverlay } from "@/lib/profile/repository";
import {
  deleteManualProfileFact,
  getProfileControlPlane,
  ProfileServiceConflictError,
  saveManualProfile,
} from "@/lib/profile/service";
import { closePool } from "@/lib/scheduler/db";
import { createMemory, getMemoryById, setMemoryProtection } from "@/lib/self-improvement/memories";

const DATABASE_AVAILABLE =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const describeIntegration = DATABASE_AVAILABLE ? describe : describe.skip;

describeIntegration("profile control-plane service", () => {
  beforeAll(() => {
    vi.stubEnv("AGENT_PROFILE_ENABLED", "true");
    vi.stubEnv("AGENT_PROFILE_EXPLICIT_WRITE_ENABLED", "true");
    vi.stubEnv("AGENT_PROFILE_SYNTHESIS_ENABLED", "false");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePool();
  });

  it("commits exact manual prose with UI provenance and tombstones omissions atomically", async () => {
    const agentId = randomUUID();
    const firstBody = [
      "Identity and context",
      "The user lives in Wellington.",
      "Preferences and constraints",
      "The user prefers concise answers.",
    ].join("\n");
    const first = await saveManualProfile({ body: firstBody, expectedVersionId: null }, agentId);

    expect(first.profile.body).toBe(firstBody);
    expect(first.profile.version).toMatchObject({ authority: "user", trigger: "manual_ui" });
    expect(first.profile.facts).toHaveLength(2);
    expect(first.profile.facts.every((fact) => fact.sourceCount >= 1)).toBe(true);
    const sourceRows = await getDb()
      .select({ source: agentProfileVersionSources, event: agentTraceEvents })
      .from(agentProfileVersionSources)
      .innerJoin(agentTraceEvents, eq(agentTraceEvents.id, agentProfileVersionSources.traceEventId))
      .where(eq(agentProfileVersionSources.profileVersionId, first.profile.version?.id as string));
    expect(sourceRows).toHaveLength(2);
    expect(sourceRows.every((row) => row.event.eventType === "explicit_memory_write")).toBe(true);

    const removed = first.profile.facts[0];
    const kept = first.profile.facts[1];
    const second = await saveManualProfile(
      { body: kept.sentence, expectedVersionId: first.profile.version?.id },
      agentId,
    );
    expect(second.profile.facts).toHaveLength(1);
    expect(second.profile.facts[0].factKey).toBe(kept.factKey);
    const [tombstone] = await getDb()
      .select()
      .from(agentProfileFactTombstones)
      .where(
        and(
          eq(agentProfileFactTombstones.agentId, agentId),
          eq(agentProfileFactTombstones.factKey, removed.factKey),
        ),
      );
    expect(tombstone).toMatchObject({ deletedBy: "manual_ui", reason: "manual_ui_omission" });
    await expect(
      saveManualProfile(
        { body: removed.sentence, expectedVersionId: second.profile.version?.id },
        agentId,
      ),
    ).rejects.toBeInstanceOf(ProfileServiceConflictError);

    const auditRowsBeforeConflict = await getDb()
      .select({ id: agentTraceEvents.id })
      .from(agentTraceEvents)
      .where(
        and(
          eq(agentTraceEvents.agentId, agentId),
          eq(agentTraceEvents.eventType, "explicit_memory_write"),
        ),
      );
    const tombstonesBeforeConflict = await getDb()
      .select({ factKey: agentProfileFactTombstones.factKey })
      .from(agentProfileFactTombstones)
      .where(eq(agentProfileFactTombstones.agentId, agentId));
    await expect(
      saveManualProfile(
        { body: "The user likes stale writes.", expectedVersionId: first.profile.version?.id },
        agentId,
      ),
    ).rejects.toBeInstanceOf(ProfileServiceConflictError);
    const auditRowsAfterConflict = await getDb()
      .select({ id: agentTraceEvents.id })
      .from(agentTraceEvents)
      .where(
        and(
          eq(agentTraceEvents.agentId, agentId),
          eq(agentTraceEvents.eventType, "explicit_memory_write"),
        ),
      );
    const tombstonesAfterConflict = await getDb()
      .select({ factKey: agentProfileFactTombstones.factKey })
      .from(agentProfileFactTombstones)
      .where(eq(agentProfileFactTombstones.agentId, agentId));
    expect(auditRowsAfterConflict).toHaveLength(auditRowsBeforeConflict.length);
    expect(tombstonesAfterConflict).toHaveLength(tombstonesBeforeConflict.length);

    const empty = await saveManualProfile(
      { body: "", expectedVersionId: second.profile.version?.id },
      agentId,
    );
    expect(empty.profile.body).toBe("");
    expect(empty.profile.facts).toEqual([]);

    const restored = await saveManualProfile(
      {
        body: "The user prefers explicit deletes.",
        expectedVersionId: empty.profile.version?.id,
      },
      agentId,
    );
    const deletedWithoutCas = await deleteManualProfileFact(
      restored.profile.facts[0].factKey,
      {},
      agentId,
    );
    expect(deletedWithoutCas.profile).toMatchObject({ body: "", facts: [] });
  });

  it("deleting a fact unprotects and archives its backing user memory in the same durable edit", async () => {
    const agentId = randomUUID();
    const memory = await createMemory({
      agentId,
      kind: "preference",
      content: "The user prefers keyboard navigation.",
      source: "user",
      confidence: 100,
    });
    await setMemoryProtection(memory.id, true, agentId);
    const factKey = `ui-delete-${randomUUID()}`;
    await getDb().transaction((tx) =>
      applyDirectiveOverlay(
        {
          agentId,
          facts: [
            {
              factKey,
              sentence: "The user prefers keyboard navigation.",
              category: "preferences_constraints",
              authority: "user",
              protected: true,
              order: 0,
            },
          ],
          sources: [
            {
              factKey,
              sourceRole: "primary",
              traceEventId: null,
              memoryVersionId: memory.currentVersionId,
            },
          ],
          body: "Preferences and constraints\nThe user prefers keyboard navigation.",
          tokenCount: 8,
          trigger: "manual_ui",
          modelId: null,
          promptHash: "test-manual-overlay",
          policyVersion: "test",
        },
        tx,
      ),
    );
    const before = await getProfileControlPlane(agentId);
    const deleted = await deleteManualProfileFact(
      factKey,
      { expectedVersionId: before.version?.id },
      agentId,
    );

    expect(deleted.profile).toMatchObject({ body: "", facts: [] });
    const archived = await getMemoryById(memory.id, agentId);
    expect(archived).toMatchObject({ status: "archived", isProtected: false });
    const [tombstone] = await getDb()
      .select()
      .from(agentProfileFactTombstones)
      .where(
        and(
          eq(agentProfileFactTombstones.agentId, agentId),
          eq(agentProfileFactTombstones.factKey, factKey),
        ),
      );
    expect(tombstone?.reason).toBe("manual_ui_delete");
    await expect(
      deleteManualProfileFact(factKey, { expectedVersionId: before.version?.id }, agentId),
    ).rejects.toBeInstanceOf(ProfileServiceConflictError);
  });

  it("rejects authoritative mandatory facts that exceed the renderable budget", async () => {
    const agentId = randomUUID();
    const body = Array.from({ length: 4 }, (_, index) => `${index}${"界".repeat(899)}。`).join(
      "\n",
    );
    await expect(
      saveManualProfile({ body, expectedVersionId: null }, agentId),
    ).rejects.toBeInstanceOf(ProfileMandatoryFactsOverBudgetError);
    expect((await getProfileControlPlane(agentId)).version).toBeNull();
  });

  it("archives backing user memories when PUT omits their fact", async () => {
    const agentId = randomUUID();
    const sentence = "The user prefers reduced motion.";
    const memory = await createMemory({
      agentId,
      kind: "preference",
      content: sentence,
      source: "user",
      confidence: 100,
    });
    const factKey = `ui-omit-${randomUUID()}`;
    await getDb().transaction((tx) =>
      applyDirectiveOverlay(
        {
          agentId,
          facts: [
            {
              factKey,
              sentence,
              category: "preferences_constraints",
              authority: "user",
              protected: false,
              order: 0,
            },
          ],
          sources: [
            {
              factKey,
              sourceRole: "primary",
              traceEventId: null,
              memoryVersionId: memory.currentVersionId,
            },
          ],
          body: `Preferences and constraints\n${sentence}`,
          tokenCount: 8,
          trigger: "manual_ui",
          modelId: null,
          promptHash: "test-manual-omission",
          policyVersion: "test",
        },
        tx,
      ),
    );
    const before = await getProfileControlPlane(agentId);
    await saveManualProfile({ body: "", expectedVersionId: before.version?.id }, agentId);
    expect(await getMemoryById(memory.id, agentId)).toMatchObject({ status: "archived" });
  });

  it("returns source links only for live chats owned by the profile agent", async () => {
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const liveSessionId = randomUUID();
    const deletedSessionId = randomUUID();
    const foreignSessionId = randomUUID();
    const db = getDb();
    await db.insert(agentChatSessions).values([
      { id: liveSessionId, agentId, origin: "chat", title: "Live source" },
      {
        id: deletedSessionId,
        agentId,
        origin: "chat",
        title: "Deleted source",
        deletedAt: new Date(),
      },
      { id: foreignSessionId, agentId: otherAgentId, origin: "chat", title: "Foreign source" },
    ]);
    const eventInputs = [
      { sessionId: liveSessionId, suffix: "live" },
      { sessionId: deletedSessionId, suffix: "deleted" },
      { sessionId: foreignSessionId, suffix: "foreign" },
    ].map(({ sessionId, suffix }, index) => ({
      agentId,
      traceId: `profile-source-links:${randomUUID()}`,
      sequenceNo: 0,
      sessionId,
      eventType: "explicit_memory_write" as const,
      actor: "user" as const,
      trustClass: "user_assertion" as const,
      payload: { operation: "test", suffix },
      contentHash: `hash-${suffix}-${randomUUID()}`,
      idempotencyKey: `profile-source-${suffix}-${randomUUID()}`,
      retentionClass: "audit" as const,
      policyVersion: "test",
      occurredAt: new Date(Date.now() + index),
    }));
    const events = await appendTraceEvents(eventInputs, db);
    const factKey = `source-links-${randomUUID()}`;
    await db.transaction((tx) =>
      applyDirectiveOverlay(
        {
          agentId,
          facts: [
            {
              factKey,
              sentence: "The user validates source scoping.",
              category: "active_projects_goals",
              authority: "user",
              protected: false,
              order: 0,
            },
          ],
          sources: events.map((event, index) => ({
            factKey,
            sourceRole: index === 0 ? ("primary" as const) : ("corroborating" as const),
            traceEventId: event.id,
            memoryVersionId: null,
          })),
          body: "Active projects and goals\nThe user validates source scoping.",
          tokenCount: 8,
          trigger: "manual_ui",
          modelId: null,
          promptHash: "test-source-links",
          policyVersion: "test",
        },
        tx,
      ),
    );

    const profile = await getProfileControlPlane(agentId);
    expect(profile.facts[0].sourceCount).toBe(3);
    expect(profile.facts[0].sourceSessions).toEqual([
      { sessionId: liveSessionId, title: "Live source", href: `/?c=${liveSessionId}` },
    ]);
    expect(profile.facts[0].sourceSessions.map((source) => source.title)).not.toContain(
      "Deleted source",
    );
    expect(profile.facts[0].sourceSessions.map((source) => source.title)).not.toContain(
      "Foreign source",
    );
  });
});
