import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getDb } from "@/db";
import { agentMemoryDocuments, agentTraceEvents } from "@/db/schema";
import { projectMemoryDocument } from "@/lib/memory-document/format";
import { commitMemoryDocument, readMemoryDocument } from "@/lib/memory-document/repository";
import type { MemoryDocumentEntry, MemoryWriteMetadata } from "@/lib/memory-document/types";
import { applyMemoryTimestampRule } from "@/lib/memory-document/writer";
import { closePool, getPool } from "@/lib/scheduler/db";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

const FIRST_AT = "2026-06-22T10:11:12.345Z";
const SECOND_AT = "2026-06-23T11:12:13.456Z";

integration("memory document repository", () => {
  const agentIds = new Set<string>();

  beforeAll(() => {
    getPool();
  });

  afterAll(async () => {
    const ids = [...agentIds];
    if (ids.length > 0) {
      await getDb().delete(agentTraceEvents).where(inArray(agentTraceEvents.agentId, ids));
      await getDb().delete(agentMemoryDocuments).where(inArray(agentMemoryDocuments.agentId, ids));
    }
    await closePool();
  });

  it("returns a virtual empty version 0 when no row exists", async () => {
    const agentId = isolatedAgentId(agentIds);

    await expect(readMemoryDocument(agentId)).resolves.toEqual({
      agentId,
      version: 0,
      indexBody: "",
      details: [],
      indexTokenCount: 0,
      detailsTokenCount: 0,
      createdAt: null,
      updatedAt: null,
    });
  });

  it("inserts version 1 for the first expected-version-0 commit", async () => {
    const agentId = isolatedAgentId(agentIds);
    const entries = [memoryEntry(1, FIRST_AT)];

    await expect(
      commitMemoryDocument({
        agentId,
        expectedVersion: 0,
        entries,
        source: "tool",
        metadata: metadata(entries, { newKeys: [entries[0].key] }),
        now: new Date(FIRST_AT),
      }),
    ).resolves.toEqual({ status: "applied", version: 1 });

    const stored = await readMemoryDocument(agentId);
    expect(stored).toMatchObject({
      agentId,
      version: 1,
      details: entries,
    });
    expect(stored.createdAt).toBe(FIRST_AT);
    expect(stored.updatedAt).toBe(FIRST_AT);
  });

  it("updates the expected version to 2 with retained and refreshed timestamps", async () => {
    const agentId = isolatedAgentId(agentIds);
    const first = memoryEntry(2, FIRST_AT);
    await commitMemoryDocument({
      agentId,
      expectedVersion: 0,
      entries: [first],
      source: "tool",
      metadata: metadata([first], { newKeys: [first.key] }),
      now: new Date(FIRST_AT),
    });

    const transformed = applyMemoryTimestampRule(
      [first],
      [
        {
          key: first.key,
          summary: "The user prefers concise technical responses.",
          details: [first.details[0].text, "Include one concrete example."],
        },
      ],
      { now: SECOND_AT },
    ).entries;

    await expect(
      commitMemoryDocument({
        agentId,
        expectedVersion: 1,
        entries: transformed,
        source: "tool",
        metadata: metadata(transformed, { affectedKeys: [first.key] }),
        now: new Date(SECOND_AT),
      }),
    ).resolves.toEqual({ status: "applied", version: 2 });

    const stored = await readMemoryDocument(agentId);
    expect(stored.version).toBe(2);
    expect(stored.updatedAt).toBe(SECOND_AT);
    expect(stored.details).toEqual([
      {
        key: first.key,
        updatedAt: SECOND_AT,
        summary: "The user prefers concise technical responses.",
        details: [
          { timestamp: FIRST_AT, text: first.details[0].text },
          { timestamp: SECOND_AT, text: "Include one concrete example." },
        ],
      },
    ]);
  });

  it("returns conflict for a stale version without changing the row", async () => {
    const agentId = isolatedAgentId(agentIds);
    const first = memoryEntry(3, FIRST_AT);
    await commitMemoryDocument({
      agentId,
      expectedVersion: 0,
      entries: [first],
      source: "tool",
      metadata: metadata([first], { newKeys: [first.key] }),
      now: new Date(FIRST_AT),
    });
    const second = [
      {
        ...first,
        updatedAt: SECOND_AT,
        summary: "The user prefers direct answers.",
      },
    ];
    await commitMemoryDocument({
      agentId,
      expectedVersion: 1,
      entries: second,
      source: "tool",
      metadata: metadata(second, { affectedKeys: [first.key] }),
      now: new Date(SECOND_AT),
    });
    const beforeConflict = await readMemoryDocument(agentId);
    const stale = [
      {
        ...first,
        updatedAt: "2026-06-24T12:13:14.567Z",
        summary: "The user prefers verbose answers.",
      },
    ];

    await expect(
      commitMemoryDocument({
        agentId,
        expectedVersion: 1,
        entries: stale,
        source: "tool",
        metadata: metadata(stale, { affectedKeys: [first.key] }),
      }),
    ).resolves.toEqual({ status: "conflict", version: 2 });

    expect(await readMemoryDocument(agentId)).toEqual(beforeConflict);
  });

  it("allows exactly one winner when two commits race on the same expected version", async () => {
    const agentId = isolatedAgentId(agentIds);
    const first = memoryEntry(6, FIRST_AT);
    await commitMemoryDocument({
      agentId,
      expectedVersion: 0,
      entries: [first],
      source: "tool",
      metadata: metadata([first], { newKeys: [first.key] }),
      now: new Date(FIRST_AT),
    });

    const candidateA = [
      {
        ...first,
        updatedAt: SECOND_AT,
        summary: "The user prefers concise technical responses.",
      },
    ];
    const candidateB = [
      {
        ...first,
        updatedAt: SECOND_AT,
        summary: "The user prefers concise direct responses.",
      },
    ];

    const [resultA, resultB] = await Promise.all([
      commitMemoryDocument({
        agentId,
        expectedVersion: 1,
        entries: candidateA,
        source: "tool",
        metadata: metadata(candidateA, { affectedKeys: [first.key] }),
        now: new Date(SECOND_AT),
      }),
      commitMemoryDocument({
        agentId,
        expectedVersion: 1,
        entries: candidateB,
        source: "tool",
        metadata: metadata(candidateB, { affectedKeys: [first.key] }),
        now: new Date(SECOND_AT),
      }),
    ]);

    expect([resultA.status, resultB.status].sort()).toEqual(["applied", "conflict"]);
    expect(resultA.version).toBe(2);
    expect(resultB.version).toBe(2);
    const winningEntries = resultA.status === "applied" ? candidateA : candidateB;
    const stored = await readMemoryDocument(agentId);
    expect(stored.version).toBe(2);
    expect(stored.details).toEqual(winningEntries);
  });

  it("commits the row and trace atomically, and rolls both back when trace insertion fails", async () => {
    const successfulAgentId = isolatedAgentId(agentIds);
    const successfulEntries = [memoryEntry(4, FIRST_AT)];
    await commitMemoryDocument({
      agentId: successfulAgentId,
      expectedVersion: 0,
      entries: successfulEntries,
      source: "tool",
      metadata: metadata(successfulEntries, { newKeys: [successfulEntries[0].key] }),
      now: new Date(FIRST_AT),
    });

    const [successfulRow] = await getDb()
      .select()
      .from(agentMemoryDocuments)
      .where(inArray(agentMemoryDocuments.agentId, [successfulAgentId]));
    const [successfulTrace] = await getDb()
      .select()
      .from(agentTraceEvents)
      .where(inArray(agentTraceEvents.agentId, [successfulAgentId]));
    expect(successfulRow?.version).toBe(1);
    expect(successfulTrace).toMatchObject({
      eventType: "explicit_memory_write",
      payload: expect.objectContaining({ source: "tool", version: 1 }),
    });

    const failingAgentId = isolatedAgentId(agentIds);
    const failingEntries = [memoryEntry(5, FIRST_AT)];
    const oversizedAffectedKeys = Array.from(
      { length: 4_000 },
      (_, index) => `mem_${index.toString(16).padStart(32, "0")}`,
    );

    await expect(
      commitMemoryDocument({
        agentId: failingAgentId,
        expectedVersion: 0,
        entries: failingEntries,
        source: "tool",
        metadata: metadata(failingEntries, { affectedKeys: oversizedAffectedKeys }),
        now: new Date(FIRST_AT),
      }),
    ).rejects.toThrow();

    const failedRows = await getDb()
      .select()
      .from(agentMemoryDocuments)
      .where(inArray(agentMemoryDocuments.agentId, [failingAgentId]));
    const failedTraces = await getDb()
      .select()
      .from(agentTraceEvents)
      .where(inArray(agentTraceEvents.agentId, [failingAgentId]));
    expect(failedRows).toEqual([]);
    expect(failedTraces).toEqual([]);
  });
});

function isolatedAgentId(agentIds: Set<string>): string {
  const agentId = randomUUID();
  agentIds.add(agentId);
  return agentId;
}

function memoryEntry(index: number, timestamp: string): MemoryDocumentEntry {
  return {
    key: `mem_${index.toString(16).padStart(32, "0")}`,
    updatedAt: timestamp,
    summary: "The user prefers concise responses.",
    details: [{ timestamp, text: "Lead with the answer." }],
  };
}

function metadata(
  entries: readonly MemoryDocumentEntry[],
  changes: Partial<Pick<MemoryWriteMetadata, "affectedKeys" | "newKeys" | "droppedKeys">> = {},
): MemoryWriteMetadata {
  const projection = projectMemoryDocument(entries);
  return {
    entryCount: entries.length,
    indexTokenCount: projection.indexTokenCount,
    detailsTokenCount: projection.detailsTokenCount,
    affectedKeys: changes.affectedKeys ?? [],
    newKeys: changes.newKeys ?? [],
    droppedKeys: changes.droppedKeys ?? [],
    changedSummaries: [],
  };
}
