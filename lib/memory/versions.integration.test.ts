import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentGroundedObservations,
  agentMemories,
  agentMemoryEvents,
  agentMemoryVersions,
  agentMemoryVersionTraceEvents,
  agentTraceEvents,
} from "@/db/schema";
import { searchRankedRecall } from "@/lib/memory/recall";
import { createVersionedMemory } from "@/lib/memory/versions";
import { closePool, getPool } from "@/lib/scheduler/db";
import {
  archiveMemory,
  createMemory,
  getMemoryById,
  listApprovedMemories,
  listMemories,
  updateMemory,
} from "@/lib/self-improvement/memories";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("versioned memory authority (integration)", () => {
  const agentId = randomUUID();
  beforeAll(() => getPool());
  afterAll(async () => {
    const db = getDb();
    await db
      .delete(agentGroundedObservations)
      .where(eq(agentGroundedObservations.agentId, agentId));
    await db.delete(agentMemoryEvents).where(eq(agentMemoryEvents.agentId, agentId));
    const roots = await db
      .select({ id: agentMemories.id })
      .from(agentMemories)
      .where(eq(agentMemories.agentId, agentId));
    for (const root of roots) {
      const versions = await db
        .select({ id: agentMemoryVersions.id })
        .from(agentMemoryVersions)
        .where(eq(agentMemoryVersions.memoryId, root.id));
      for (const version of versions) {
        await db
          .delete(agentMemoryVersionTraceEvents)
          .where(eq(agentMemoryVersionTraceEvents.memoryVersionId, version.id));
      }
      await db
        .update(agentMemories)
        .set({ currentVersionId: null, status: "creating" })
        .where(eq(agentMemories.id, root.id));
      await db.delete(agentMemoryVersions).where(eq(agentMemoryVersions.memoryId, root.id));
    }
    await db.delete(agentMemories).where(eq(agentMemories.agentId, agentId));
    await db.delete(agentTraceEvents).where(eq(agentTraceEvents.agentId, agentId));
    await closePool();
  });

  it("creates provenance, appends immutable versions, and closes recorded time", async () => {
    const created = await createMemory({
      agentId,
      kind: "fact",
      content: "The deployment region is Singapore.",
      source: "user",
      confidence: 80,
    });
    expect(created.currentVersionId).toBeTruthy();
    const provenance = await getDb()
      .select()
      .from(agentMemoryVersionTraceEvents)
      .where(eq(agentMemoryVersionTraceEvents.memoryVersionId, created.currentVersionId));
    expect(provenance.length).toBeGreaterThan(0);

    const updated = await updateMemory(
      created.id,
      {
        content: "The deployment region is Sydney.",
        confidence: 90,
      },
      agentId,
    );
    expect(updated.content).toContain("Sydney");
    const versions = await getDb()
      .select({
        versionNo: agentMemoryVersions.versionNo,
        content: agentMemoryVersions.content,
        upper: sql<string | null>`upper(${agentMemoryVersions.recordedDuring})`,
      })
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.memoryId, created.id))
      .orderBy(agentMemoryVersions.versionNo);
    expect(versions.map((row) => row.versionNo)).toEqual([1, 2]);
    expect(versions[0].content).toContain("Singapore");
    expect(versions[0].upper).not.toBeNull();
  });

  it("invalidates by appending history and excludes the root from current reads", async () => {
    const memory = await createMemory({
      agentId,
      kind: "fact",
      content: "Temporary project state.",
      source: "user",
    });
    const archived = await archiveMemory(memory.id, agentId);
    expect(archived.status).toBe("archived");
    const versions = await getDb()
      .select()
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.memoryId, memory.id))
      .orderBy(agentMemoryVersions.versionNo);
    expect(versions.at(-1)?.operation).toBe("INVALIDATE");
    expect((await getMemoryById(memory.id, agentId))?.status).toBe("archived");
    expect((await listMemories(agentId)).some((item) => item.id === memory.id)).toBe(true);
    expect((await listApprovedMemories(agentId)).some((item) => item.id === memory.id)).toBe(false);
  });

  it("preserves structured, temporal, expiry, scoring, and sensitivity metadata on edit", async () => {
    const eventMemory = await createMemory({
      agentId,
      kind: "fact",
      content: "Metadata evidence source.",
      source: "user",
    });
    const [evidence] = await getDb()
      .select({ eventId: agentMemoryVersionTraceEvents.eventId })
      .from(agentMemoryVersionTraceEvents)
      .where(eq(agentMemoryVersionTraceEvents.memoryVersionId, eventMemory.currentVersionId));
    const validFrom = new Date(Date.now() - 1_000);
    const validTo = new Date(Date.now() + 86_400_000);
    const expiresAt = new Date(Date.now() + 172_800_000);
    const created = await createVersionedMemory({
      agentId,
      kind: "fact",
      content: "Bounded structured memory.",
      source: "review",
      confidence: 75,
      sourceEventIds: [evidence.eventId],
      authority: "reviewed",
      structured: { key: "value" },
      validFrom,
      validTo,
      timeSource: "user_statement",
      observedAt: validFrom,
      lastConfirmedAt: validFrom,
      expiresAt,
      importance: 88,
      utilityScoreBps: 7777,
      sensitivityClass: "sensitive",
    });
    await updateMemory(
      created.root.id,
      { content: "Edited bounded memory.", kind: "preference" },
      agentId,
    );
    const [current] = await getDb()
      .select({ root: agentMemories, version: agentMemoryVersions })
      .from(agentMemories)
      .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId))
      .where(eq(agentMemories.id, created.root.id));
    expect(current.version.structured).toEqual({ key: "value" });
    expect(current.version.validDuring).toBeTruthy();
    expect(current.version.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    expect(current.version.importance).toBe(88);
    expect(current.version.utilityScoreBps).toBe(7777);
    expect(current.version.sensitivityClass).toBe("sensitive");
    expect(current.root.conflictPolicy).toBe("replace_current");
  });

  it("aborts a source-less or foreign-evidence curated write", async () => {
    await expect(
      createVersionedMemory({
        agentId,
        kind: "fact",
        content: "Unsupported memory.",
        source: "review",
        confidence: 50,
        sourceEventIds: [],
        authority: "reviewed",
      }),
    ).rejects.toThrow(/evidence/);
    const roots = await getDb()
      .select()
      .from(agentMemories)
      .where(
        and(eq(agentMemories.agentId, agentId), eq(agentMemories.canonicalKey, "unsupported")),
      );
    expect(roots).toHaveLength(0);
  });

  it("serializes concurrent updates into unique monotonic versions", async () => {
    const memory = await createMemory({
      agentId,
      kind: "preference",
      content: "Use blue charts.",
      source: "user",
    });
    await Promise.all([
      updateMemory(memory.id, { content: "Use green charts." }, agentId),
      updateMemory(memory.id, { content: "Use amber charts." }, agentId),
    ]);
    const versions = await getDb()
      .select({ versionNo: agentMemoryVersions.versionNo })
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.memoryId, memory.id))
      .orderBy(agentMemoryVersions.versionNo);
    expect(versions.map((row) => row.versionNo)).toEqual([1, 2, 3]);
  });

  it("searches canonical current versions with FTS and trigram fallback", async () => {
    const marker = `observability${Date.now()}`;
    const memory = await createMemory({
      agentId,
      kind: "procedure",
      content: `${marker} verify deployment telemetry`,
      source: "user",
    });
    const asOf = new Date(Date.now() + 1_000);
    expect(
      (await searchRankedRecall({ agentId, query: `${marker} telemetry`, asOf })).some(
        (row) => row.id === memory.id,
      ),
    ).toBe(true);
    expect(
      (await searchRankedRecall({ agentId, query: `${marker.slice(0, -1)}x`, asOf })).some(
        (row) => row.id === memory.id,
      ),
    ).toBe(true);
  });
});
