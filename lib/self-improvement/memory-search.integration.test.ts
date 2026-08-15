import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
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
  let memoryId = "";

  beforeAll(async () => {
    getPool();
    const memory = await createMemory({
      agentId: DEFAULT_AGENT_ID,
      kind: "procedure",
      memoryType: "procedural",
      content: `${marker} verify deployment telemetry`,
      source: "curated",
      confidence: 87,
    });
    memoryId = memory.id;
  });

  afterAll(async () => {
    const db = getDb();
    const versions = await db
      .select({ id: agentMemoryVersions.id })
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.memoryId, memoryId));
    const eventIds: string[] = [];
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
    await db.delete(agentMemoryEvents).where(eq(agentMemoryEvents.memoryId, memoryId));
    await db
      .update(agentMemories)
      .set({ currentVersionId: null, status: "creating" })
      .where(eq(agentMemories.id, memoryId));
    await db.delete(agentMemoryVersions).where(eq(agentMemoryVersions.memoryId, memoryId));
    await db.delete(agentMemories).where(eq(agentMemories.id, memoryId));
    for (const eventId of eventIds) {
      await db.delete(agentTraceEvents).where(eq(agentTraceEvents.id, eventId));
    }
    await closePool();
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
