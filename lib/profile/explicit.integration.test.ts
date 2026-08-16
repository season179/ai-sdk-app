import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  agentMemories,
  agentMemoryVersions,
  agentMemoryVersionTraceEvents,
  agentProfileFactTombstones,
  agentProfiles,
  agentTraceEvents,
} from "@/db/schema";
import { appendSessionMessages, materializeMessageRunProjection } from "@/lib/chat/sessions";
import { applyExplicitProfileIntent } from "@/lib/profile/explicit";
import { getCurrentProfile } from "@/lib/profile/repository";
import type { ProfileSynthesisResult } from "@/lib/profile/types";
import { closePool, getPool } from "@/lib/scheduler/db";
import { createMemory, setMemoryProtection } from "@/lib/self-improvement/memories";

const DATABASE_AVAILABLE =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const describeIntegration = DATABASE_AVAILABLE ? describe : describe.skip;

const completedSynthesis = vi.fn(
  async (): Promise<ProfileSynthesisResult> => ({
    result: "noop",
    profileVersionId: null,
    versionNo: null,
  }),
);

async function fixture() {
  const agentId = randomUUID();
  const sessionId = randomUUID();
  await getPool().query(
    "insert into agent_chat_sessions (id, agent_id, origin) values ($1, $2, 'chat')",
    [sessionId, agentId],
  );
  return { agentId, sessionId };
}

function applyOptions(
  scope: Awaited<ReturnType<typeof fixture>>,
  messageId: string,
  rawUserText: string,
  overrides: Partial<Parameters<typeof applyExplicitProfileIntent>[1]> = {},
) {
  return {
    ...scope,
    messageId,
    rawUserText,
    synthesize: completedSynthesis as Parameters<
      typeof applyExplicitProfileIntent
    >[1]["synthesize"],
    ...overrides,
  };
}

describeIntegration("explicit profile state edits (integration)", () => {
  afterAll(async () => closePool());

  it("remembers and corrects through one user-authority canonical memory with trace provenance", async () => {
    const scope = await fixture();
    const remembered = await applyExplicitProfileIntent(
      { action: "remember", content: "My favorite color is blue." },
      applyOptions(scope, "msg-remember", "remember that My favorite color is blue."),
    );
    expect(remembered).toMatchObject({
      durable: true,
      action: "remember",
      synthesis: "completed",
    });
    if (!remembered.memoryId) throw new Error("Remember did not return a memory id.");
    const memoryId = remembered.memoryId;

    const db = getDb();
    const [created] = await db
      .select({ root: agentMemories, version: agentMemoryVersions })
      .from(agentMemories)
      .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId))
      .where(eq(agentMemories.id, memoryId));
    expect(created.root).toMatchObject({
      agentId: scope.agentId,
      scopeType: "agent",
      scopeId: scope.agentId,
      status: "approved",
    });
    expect(created.version).toMatchObject({
      source: "user",
      authority: "user",
      content: "My favorite color is blue.",
    });
    const links = await db
      .select({ eventType: agentTraceEvents.eventType })
      .from(agentMemoryVersionTraceEvents)
      .innerJoin(agentTraceEvents, eq(agentTraceEvents.id, agentMemoryVersionTraceEvents.eventId))
      .where(eq(agentMemoryVersionTraceEvents.memoryVersionId, created.version.id));
    expect(links).toEqual([{ eventType: "explicit_memory_write" }]);

    const corrected = await applyExplicitProfileIntent(
      {
        action: "correct",
        targetText: "My favorite color is blue.",
        content: "My favorite color is green.",
      },
      applyOptions(
        scope,
        "msg-correct",
        "correct My favorite color is blue. to My favorite color is green.",
      ),
    );
    expect(corrected.memoryId).toBe(memoryId);
    expect(corrected.factKey).toBe(remembered.factKey);
    const [updated] = await db
      .select({ root: agentMemories, version: agentMemoryVersions })
      .from(agentMemories)
      .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId))
      .where(eq(agentMemories.id, memoryId));
    expect(updated.version).toMatchObject({
      versionNo: 2,
      content: "My favorite color is green.",
      source: "user",
      authority: "user",
    });
    expect((await getCurrentProfile(scope.agentId))?.facts).toEqual([
      expect.objectContaining({
        factKey: remembered.factKey,
        sentence: "My favorite color is green.",
        authority: "user",
      }),
    ]);
  });

  it("replays a duplicate route/tool application without a second memory version or audit event", async () => {
    const scope = await fixture();
    const intent = { action: "remember" as const, content: "I prefer dark mode." };
    const options = applyOptions(scope, "msg-duplicate", "remember that I prefer dark mode.");
    const first = await applyExplicitProfileIntent(intent, options);
    const second = await applyExplicitProfileIntent(intent, options);
    expect(second).toMatchObject({
      durable: true,
      action: "remember",
      memoryId: first.memoryId,
      factKey: first.factKey,
    });
    if (!first.memoryId) throw new Error("Remember did not return a memory id.");

    const db = getDb();
    const versions = await db
      .select({ id: agentMemoryVersions.id })
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.memoryId, first.memoryId));
    expect(versions).toHaveLength(1);
    const events = await db
      .select({ id: agentTraceEvents.id })
      .from(agentTraceEvents)
      .where(
        and(
          eq(agentTraceEvents.agentId, scope.agentId),
          eq(agentTraceEvents.sourceMessageId, "msg-duplicate"),
          eq(agentTraceEvents.eventType, "explicit_memory_write"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("rejects normalized exact-text ambiguity without storing an audit write", async () => {
    const scope = await fixture();
    const eventId = randomUUID();
    await getPool().query(
      `insert into agent_trace_events
        (id, agent_id, trace_id, sequence_no, session_id, event_type, actor, trust_class,
         payload, content_hash, idempotency_key, retention_class, policy_version, occurred_at)
       values ($1,$2,$3,0,$4,'explicit_memory_write','user','user_assertion','{}',$5,$6,'audit','test',now())`,
      [
        eventId,
        scope.agentId,
        `ambiguous:${eventId}`,
        scope.sessionId,
        `hash:${eventId}`,
        `ambiguous:${eventId}`,
      ],
    );
    await getDb().transaction(async (tx) => {
      await createMemory(
        {
          agentId: scope.agentId,
          kind: "fact",
          content: "I like tea.",
          source: "user",
          canonicalKey: `fact:${randomUUID()}`,
          sourceEventIds: [eventId],
        },
        tx,
      );
      await createMemory(
        {
          agentId: scope.agentId,
          kind: "preference",
          content: "I like tea!",
          source: "user",
          canonicalKey: `preference:${randomUUID()}`,
          sourceEventIds: [eventId],
        },
        tx,
      );
    });

    await expect(
      applyExplicitProfileIntent(
        { action: "forget", targetText: "I like tea" },
        applyOptions(scope, "msg-ambiguous", "forget I like tea"),
      ),
    ).rejects.toMatchObject({ code: "ambiguous" });
    const events = await getDb()
      .select({ id: agentTraceEvents.id })
      .from(agentTraceEvents)
      .where(
        and(
          eq(agentTraceEvents.agentId, scope.agentId),
          eq(agentTraceEvents.sourceMessageId, "msg-ambiguous"),
        ),
      );
    expect(events).toEqual([]);
  });

  it("atomically overrides protection, archives, tombstones, and removes the overlay", async () => {
    const scope = await fixture();
    const remembered = await applyExplicitProfileIntent(
      { action: "remember", content: "I prefer paper reports." },
      applyOptions(scope, "msg-pin", "remember that I prefer paper reports."),
    );
    if (!remembered.memoryId) throw new Error("Remember did not return a memory id.");
    const memoryId = remembered.memoryId;
    await setMemoryProtection(memoryId, true, scope.agentId, "test");

    const forgotten = await applyExplicitProfileIntent(
      { action: "forget", targetMemoryId: memoryId },
      applyOptions(scope, "msg-forget", "forget I prefer paper reports."),
    );
    expect(forgotten).toMatchObject({ durable: true, action: "forget" });

    const db = getDb();
    const [root] = await db.select().from(agentMemories).where(eq(agentMemories.id, memoryId));
    expect(root).toMatchObject({ status: "archived", tombstoned: true, isProtected: false });
    const [tombstone] = await db
      .select()
      .from(agentProfileFactTombstones)
      .where(
        and(
          eq(agentProfileFactTombstones.agentId, scope.agentId),
          eq(agentProfileFactTombstones.factKey, remembered.factKey),
        ),
      );
    expect(tombstone).toMatchObject({ retiredAt: null, deletedBy: "user" });
    expect((await getCurrentProfile(scope.agentId))?.facts).toEqual([]);
  });

  it("retires a tombstone only through a later explicit reversal", async () => {
    const scope = await fixture();
    const remembered = await applyExplicitProfileIntent(
      { action: "remember", content: "I use metric units." },
      applyOptions(scope, "msg-units", "remember that I use metric units."),
    );
    await applyExplicitProfileIntent(
      { action: "forget", targetFactKey: remembered.factKey },
      applyOptions(scope, "msg-units-forget", "forget I use metric units."),
    );
    const db = getDb();
    let [tombstone] = await db
      .select()
      .from(agentProfileFactTombstones)
      .where(
        and(
          eq(agentProfileFactTombstones.agentId, scope.agentId),
          eq(agentProfileFactTombstones.factKey, remembered.factKey),
        ),
      );
    expect(tombstone.retiredAt).toBeNull();

    await applyExplicitProfileIntent(
      { action: "remember", content: "I use metric units." },
      applyOptions(scope, "msg-units-again", "remember that I use metric units."),
    );
    [tombstone] = await db
      .select()
      .from(agentProfileFactTombstones)
      .where(
        and(
          eq(agentProfileFactTombstones.agentId, scope.agentId),
          eq(agentProfileFactTombstones.factKey, remembered.factKey),
        ),
      );
    expect(tombstone.retiredAt).not.toBeNull();
    expect(tombstone.retiredTraceEventId).not.toBeNull();
  });

  it("returns queued after inline failure while keeping a durable dirty overlay", async () => {
    const scope = await fixture();
    const enqueue = vi.fn(async () => "job-explicit");
    const result = await applyExplicitProfileIntent(
      { action: "remember", content: "I need captions." },
      applyOptions(scope, "msg-queued", "remember that I need captions.", {
        synthesize: vi.fn(async () => {
          throw new Error("model unavailable");
        }) as Parameters<typeof applyExplicitProfileIntent>[1]["synthesize"],
        enqueue,
      }),
    );
    expect(result).toMatchObject({ durable: true, synthesis: "queued" });
    expect(enqueue).toHaveBeenCalledWith(scope.agentId, { trigger: "explicit_fallback" });
    const [root] = await getDb()
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, scope.agentId));
    expect(root.dirtyGeneration).toBeGreaterThan(root.synthesizedGeneration);
    expect((await getCurrentProfile(scope.agentId))?.body).toBe(
      "Identity and context\nI need captions.",
    );
  });

  it("reports pending rather than queued when no fallback job was created", async () => {
    const scope = await fixture();
    const result = await applyExplicitProfileIntent(
      { action: "remember", content: "The user needs large text." },
      applyOptions(scope, "msg-pending", "remember that The user needs large text.", {
        synthesize: vi.fn(async () => {
          throw new Error("model unavailable");
        }) as Parameters<typeof applyExplicitProfileIntent>[1]["synthesize"],
        enqueue: vi.fn(async () => null),
      }),
    );
    expect(result).toMatchObject({ durable: true, synthesis: "pending" });
  });

  it("lets a brand-new session bind the already committed overlay version", async () => {
    const scope = await fixture();
    const remembered = await applyExplicitProfileIntent(
      { action: "remember", content: "I prefer short answers." },
      applyOptions(scope, "msg-overlay", "remember that I prefer short answers."),
    );
    const newSessionId = randomUUID();
    const messageId = "msg-new-session";
    await appendSessionMessages(
      newSessionId,
      [{ id: messageId, role: "user", parts: [{ type: "text", text: "Hello" }] }],
      { createIfMissing: true, agentId: scope.agentId },
    );
    const winner = await materializeMessageRunProjection(
      newSessionId,
      messageId,
      [{ type: "text", text: "Hello" }],
      [{ type: "text", text: "Hello" }],
      remembered.profileVersionId,
    );
    expect(winner.profileVersionId).toBe(remembered.profileVersionId);
  });
});
