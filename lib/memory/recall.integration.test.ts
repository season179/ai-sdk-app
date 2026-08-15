import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentDecisions,
  agentDecisionTraceEvents,
  agentGroundedObservations,
  agentMemories,
  agentMemoryEvents,
  agentMemoryVersions,
  agentMemoryVersionTraceEvents,
  agentOutcomes,
  agentOutcomeTraceEvents,
  agentTraceEvents,
} from "@/db/schema";
import { postgresRecallRepository } from "@/lib/memory/repository";
import { closePool, getPool } from "@/lib/scheduler/db";
import { createMemory, updateMemory } from "@/lib/self-improvement/memories";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("Postgres recall repository", () => {
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const sessionId = randomUUID();
  const marker = `recall${Date.now()}`;
  // Capture one read instant after all ordinary seed writes will have begun.
  const asOf = new Date(Date.now() + 60_000);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    getPool();
    ids.exact = (
      await createMemory({
        agentId,
        kind: "fact",
        content: `${marker} database connection refused errno 61`,
        source: "curated",
        confidence: 90,
      })
    ).id;
    ids.typo = (
      await createMemory({
        agentId,
        kind: "procedure",
        content: `${marker} observability deployment telemetry checklist`,
        source: "curated",
        confidence: 80,
      })
    ).id;
    ids.preference = (
      await createMemory({
        agentId,
        kind: "preference",
        content: `${marker} prefer compact output`,
        source: "curated",
      })
    ).id;
    ids.expired = (
      await createMemory({
        agentId,
        kind: "fact",
        content: `${marker} expired forbidden`,
        source: "curated",
      })
    ).id;
    ids.tombstoned = (
      await createMemory({
        agentId,
        kind: "fact",
        content: `${marker} tombstoned forbidden`,
        source: "curated",
      })
    ).id;
    ids.blocked = (
      await createMemory({
        agentId,
        kind: "fact",
        content: `${marker} blocked forbidden`,
        source: "curated",
      })
    ).id;
    ids.archived = (
      await createMemory({
        agentId,
        kind: "fact",
        content: `${marker} archived forbidden`,
        source: "curated",
      })
    ).id;
    ids.versioned = (
      await createMemory({
        agentId,
        kind: "fact",
        content: `${marker} obsolete version forbidden`,
        source: "curated",
      })
    ).id;
    await updateMemory(
      ids.versioned,
      { content: `${marker} current replacement visible` },
      agentId,
    );
    ids.invalidRecorded = (
      await createMemory({
        agentId,
        kind: "fact",
        content: `${marker} recorded forbidden`,
        source: "curated",
      })
    ).id;
    ids.foreign = (
      await createMemory({
        agentId: otherAgentId,
        kind: "fact",
        content: `${marker} foreign forbidden`,
        source: "curated",
      })
    ).id;
    const tieAt = new Date(asOf.getTime() - 1_000);
    for (const suffix of ["alpha", "bravo"]) {
      const memory = await createMemory({
        agentId,
        kind: "fact",
        content: `${marker} tie ${suffix}`,
        source: "curated",
        confidence: 70,
      });
      await getDb()
        .update(agentMemoryVersions)
        .set({ observedAt: tieAt, importance: 50 })
        .where(eq(agentMemoryVersions.id, memory.currentVersionId));
    }

    await getDb()
      .update(agentMemoryVersions)
      .set({ expiresAt: new Date(asOf.getTime() - 1_000) })
      .where(eq(agentMemoryVersions.memoryId, ids.expired));
    await getDb()
      .update(agentMemories)
      .set({ tombstoned: true, tombstonedAt: asOf })
      .where(eq(agentMemories.id, ids.tombstoned));
    await getDb()
      .update(agentMemories)
      .set({ injectionBlocked: true })
      .where(eq(agentMemories.id, ids.blocked));
    await getDb()
      .update(agentMemories)
      .set({ status: "archived" })
      .where(eq(agentMemories.id, ids.archived));
    await getDb()
      .update(agentMemoryVersions)
      .set({
        recordedDuring: sql`tstzrange(${new Date("2020-01-01T00:00:00Z")}, ${new Date("2020-01-02T00:00:00Z")}, '[)')`,
      })
      .where(eq(agentMemoryVersions.memoryId, ids.invalidRecorded));

    const decisionValues = (overrides: Partial<typeof agentDecisions.$inferInsert> = {}) => ({
      id: randomUUID(),
      agentId,
      sessionId: null,
      traceId: randomUUID(),
      scopeType: "agent" as const,
      scopeId: agentId,
      subjectKey: marker,
      selectedOption: "global-choice",
      declaredRationale: "deterministic test decision",
      confidence: 80,
      status: "open" as const,
      decidedAt: asOf,
      recordedDuring: `[${asOf.toISOString()},)`,
      decider: "integration-test",
      policyVersion: "test-v1",
      authority: "reviewed" as const,
      ...overrides,
    });
    const sessionDecision = decisionValues({
      id: randomUUID(),
      sessionId,
      selectedOption: "session-choice",
    });
    ids.decision = sessionDecision.id;
    await getDb()
      .insert(agentDecisions)
      .values([
        decisionValues(),
        sessionDecision,
        decisionValues({ status: "superseded", selectedOption: "superseded forbidden" }),
        decisionValues({ revokedAt: asOf, selectedOption: "revoked forbidden" }),
        decisionValues({ injectionBlocked: true, selectedOption: "blocked decision forbidden" }),
        decisionValues({
          status: "succeeded",
          decidedAt: new Date(asOf.getTime() - 40 * 86_400_000),
          recordedDuring: `[${new Date(asOf.getTime() - 40 * 86_400_000).toISOString()},)`,
          selectedOption: "stale concluded forbidden",
        }),
      ]);
    await getDb()
      .insert(agentOutcomes)
      .values([
        {
          decisionId: sessionDecision.id,
          traceId: randomUUID(),
          observedState: "older outcome",
          assessment: "inconclusive",
          confidence: 50,
          occurredAt: new Date(asOf.getTime() - 2_000),
          evaluator: "test",
          policyVersion: "test-v1",
        },
        {
          decisionId: sessionDecision.id,
          traceId: randomUUID(),
          observedState: "latest outcome",
          assessment: "supports",
          confidence: 90,
          occurredAt: new Date(asOf.getTime() - 1_000),
          evaluator: "test",
          policyVersion: "test-v1",
        },
      ]);
  });

  afterAll(async () => {
    const db = getDb();
    const decisions = await db
      .select({ id: agentDecisions.id })
      .from(agentDecisions)
      .where(eq(agentDecisions.agentId, agentId));
    for (const decision of decisions) {
      const outcomes = await db
        .select({ id: agentOutcomes.id })
        .from(agentOutcomes)
        .where(eq(agentOutcomes.decisionId, decision.id));
      for (const outcome of outcomes) {
        await db
          .delete(agentOutcomeTraceEvents)
          .where(eq(agentOutcomeTraceEvents.outcomeId, outcome.id));
      }
      await db.delete(agentOutcomes).where(eq(agentOutcomes.decisionId, decision.id));
      await db
        .delete(agentDecisionTraceEvents)
        .where(eq(agentDecisionTraceEvents.decisionId, decision.id));
    }
    await db.delete(agentDecisions).where(eq(agentDecisions.agentId, agentId));
    for (const cleanupAgentId of [agentId, otherAgentId]) {
      await db
        .delete(agentGroundedObservations)
        .where(eq(agentGroundedObservations.agentId, cleanupAgentId));
      await db.delete(agentMemoryEvents).where(eq(agentMemoryEvents.agentId, cleanupAgentId));
      const roots = await db
        .select({ id: agentMemories.id })
        .from(agentMemories)
        .where(eq(agentMemories.agentId, cleanupAgentId));
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
          .set({
            currentVersionId: null,
            status: "creating",
            tombstoned: false,
            tombstonedAt: null,
          })
          .where(eq(agentMemories.id, root.id));
        await db.delete(agentMemoryVersions).where(eq(agentMemoryVersions.memoryId, root.id));
      }
      await db.delete(agentMemories).where(eq(agentMemories.agentId, cleanupAgentId));
      await db.delete(agentTraceEvents).where(eq(agentTraceEvents.agentId, cleanupAgentId));
    }
    await closePool();
  });

  it("finds exact/error strings and trigram typos deterministically", async () => {
    const exact = await recall(`${marker} database connection refused errno 61`);
    expect(exact.general.some((item) => item.id === ids.exact)).toBe(true);

    const typoQuery = `${marker.slice(0, -1)}x observabilty deployment telemetri`;
    const typo = await recall(typoQuery);
    expect(typo.general.some((item) => item.id === ids.typo)).toBe(true);

    const repeated = await recall(`${marker} database connection refused errno 61`);
    expect(repeated.general.map((item) => item.id)).toEqual(exact.general.map((item) => item.id));
  });

  it("applies all current-view, scope, lifecycle, and temporal gates", async () => {
    const result = await recall(marker);
    const returned = new Set(result.general.map((item) => item.id));
    expect(returned.has(ids.exact)).toBe(true);
    for (const excluded of [
      ids.expired,
      ids.tombstoned,
      ids.blocked,
      ids.archived,
      ids.invalidRecorded,
      ids.foreign,
    ]) {
      expect(returned.has(excluded)).toBe(false);
    }
    expect(result.general.some((item) => item.summary.includes("obsolete version forbidden"))).toBe(
      false,
    );
    expect(result.general.some((item) => item.id === ids.versioned)).toBe(true);
    expect(result.general.length).toBeLessThanOrEqual(20);
  });

  it("orders session decisions first, excludes invalid decisions, and attaches latest outcome", async () => {
    const result = await recall(marker);
    expect(result.decisions[0]?.id).toBe(ids.decision);
    expect(result.decisions[0]?.outcome?.summary).toBe("latest outcome");
    expect(result.decisions.map((item) => item.summary)).not.toEqual(
      expect.arrayContaining([
        "superseded forbidden",
        "revoked forbidden",
        "blocked decision forbidden",
        "stale concluded forbidden",
      ]),
    );
  });

  it("respects kind and limit and resolves browse ties by stable version id", async () => {
    const filtered = await postgresRecallRepository.recall({
      agentId,
      sessionId,
      query: marker,
      kind: "preference",
      includeDecisions: false,
      generalLimit: 1,
      asOf,
    });
    expect(filtered.general).toHaveLength(1);
    expect(filtered.general[0]?.id).toBe(ids.preference);

    const browsed = await postgresRecallRepository.recall({
      agentId,
      sessionId,
      query: "*",
      includeDecisions: false,
      generalLimit: 20,
      asOf,
    });
    const ties = browsed.general.filter((item) => item.summary.includes(`${marker} tie`));
    expect(ties.map((item) => item.versionId)).toEqual(ties.map((item) => item.versionId).sort());
  });

  function recall(query: string) {
    return postgresRecallRepository.recall({
      agentId,
      sessionId,
      query,
      asOf,
      decisionLimit: 3,
      generalLimit: 20,
    });
  }
});
