import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getDb } from "@/db";
import {
  agentChatSessions,
  agentMemories,
  agentMemoryEvents,
  agentMemoryVersions,
  agentMemoryVersionTraceEvents,
  agentTraceEvents,
} from "@/db/schema";
import { closePool, getPool } from "@/lib/scheduler/db";
import { createMemory } from "@/lib/self-improvement/memories";
import { executeMemoryTool } from "@/lib/self-improvement/memory-tools";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("memory_search ranked backend mapping", () => {
  const marker = `toolrecall${Date.now()}`;
  const sessionId = "00000000-0000-4000-8000-000000000099";
  let memoryId = "";
  let scopedMemoryId = "";
  let legacyProfileMemoryId = "";

  beforeAll(async () => {
    getPool();
    await getDb().insert(agentChatSessions).values({ id: sessionId, agentId: DEFAULT_AGENT_ID });
    const memory = await createMemory({
      agentId: DEFAULT_AGENT_ID,
      kind: "procedure",
      memoryType: "procedural",
      content: `${marker} verify deployment telemetry`,
      source: "curated",
      confidence: 87,
    });
    memoryId = memory.id;
    scopedMemoryId = (
      await createMemory({
        agentId: DEFAULT_AGENT_ID,
        sessionId,
        kind: "fact",
        content: `${marker} owning session only`,
        source: "curated",
      })
    ).id;
    legacyProfileMemoryId = (
      await createMemory({
        agentId: DEFAULT_AGENT_ID,
        kind: "preference",
        content: `${marker} legacy profile directive`,
        structured: { profileDirective: { factKey: "legacy-test" } },
        source: "curated",
      })
    ).id;
  });

  afterAll(async () => {
    const db = getDb();
    const eventIds: string[] = [];
    for (const cleanupMemoryId of [memoryId, scopedMemoryId, legacyProfileMemoryId].filter(
      Boolean,
    )) {
      const versions = await db
        .select({ id: agentMemoryVersions.id })
        .from(agentMemoryVersions)
        .where(eq(agentMemoryVersions.memoryId, cleanupMemoryId));
      for (const version of versions) {
        const provenance = await db
          .select({ eventId: agentMemoryVersionTraceEvents.eventId })
          .from(agentMemoryVersionTraceEvents)
          .where(eq(agentMemoryVersionTraceEvents.memoryVersionId, version.id));
        eventIds.push(...provenance.map((row) => row.eventId));
        await db
          .delete(agentMemoryVersionTraceEvents)
          .where(eq(agentMemoryVersionTraceEvents.memoryVersionId, version.id));
      }
      await db.delete(agentMemoryEvents).where(eq(agentMemoryEvents.memoryId, cleanupMemoryId));
      await db
        .update(agentMemories)
        .set({ currentVersionId: null, status: "creating" })
        .where(eq(agentMemories.id, cleanupMemoryId));
      await db.delete(agentMemoryVersions).where(eq(agentMemoryVersions.memoryId, cleanupMemoryId));
      await db.delete(agentMemories).where(eq(agentMemories.id, cleanupMemoryId));
    }
    for (const eventId of eventIds) {
      await db.delete(agentTraceEvents).where(eq(agentTraceEvents.id, eventId));
    }
    await db.delete(agentChatSessions).where(eq(agentChatSessions.id, sessionId));
    await closePool();
  });

  it("keeps direct search scoped to the owning session", async () => {
    const owned = (await executeMemoryTool(
      "memory_search",
      { query: `${marker} owning session`, limit: 10 },
      {},
      { agentId: DEFAULT_AGENT_ID, sessionId },
    )) as { memories: Array<{ id: string }> };
    const unscoped = (await executeMemoryTool("memory_search", {
      query: `${marker} owning session`,
      limit: 10,
    })) as { memories: Array<{ id: string }> };
    expect(owned.memories.map((item) => item.id)).toContain(scopedMemoryId);
    expect(unscoped.memories.map((item) => item.id)).not.toContain(scopedMemoryId);
  });

  it("unconditionally excludes legacy profileDirective memories", async () => {
    const result = (await executeMemoryTool("memory_search", {
      query: `${marker} legacy profile directive`,
      limit: 10,
    })) as { memories: Array<{ id: string }> };
    expect(result.memories.map((item) => item.id)).not.toContain(legacyProfileMemoryId);
  });

  it("maps kind/limit and compact ranked fields from the shared repository", async () => {
    const result = (await executeMemoryTool("memory_search", {
      query: `${marker} telemetry`,
      kind: "procedure",
      limit: 1,
    })) as {
      success: boolean;
      count: number;
      memories: Array<Record<string, unknown>>;
    };
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.memories[0]).toMatchObject({
      id: memoryId,
      type: "procedural",
      kind: "procedure",
      content: expect.stringContaining(marker),
      confidence: 87,
      provenance: expect.any(Array),
      score: expect.any(Number),
    });
  });
});
