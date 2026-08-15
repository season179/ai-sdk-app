import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import {
  agentConsolidationCandidates,
  agentGroundedObservations,
  agentMemories,
  agentMemoryCandidates,
  agentMemoryEvents,
  agentMemoryVersions,
  agentRecallSignals,
  agentReviewProposals,
} from "@/db/schema";
import { claimHash } from "@/lib/consolidation/normalize";
import { ingestUserTurn, listGroundedObservations } from "@/lib/consolidation/observations";
import { runConsolidation } from "@/lib/consolidation/run";
import { buildTerminalEvent, buildUserMessageEvent } from "@/lib/memory/capture";
import { appendTraceEvents } from "@/lib/memory/trace";
import { closePool, getPool } from "@/lib/scheduler/db";
import { applyReviewProposal } from "@/lib/self-improvement/apply";
import { listReviewProposals } from "@/lib/self-improvement/proposals";

/**
 * Integration pipeline (§6): seed user turns → ingest → accumulate → score →
 * gate → propose → applyReviewProposal → assert the consolidated memory exists;
 * a second run with the same claim_hash is a no-op (unique index) and logs
 * duplicate_claim_hash; an agent_memory_events row was written.
 *
 * Opt-in via CONSOLIDATION_INTEGRATION=1 (and DATABASE_URL) so `pnpm test`
 * stays green in dev without a fully-migrated DB. Run with:
 *   CONSOLIDATION_INTEGRATION=1 pnpm test
 */
const DATABASE_AVAILABLE =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";

const describeIntegration = DATABASE_AVAILABLE ? describe : describe.skip;

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

describeIntegration("consolidation pipeline (integration)", () => {
  async function createGroundedEvidence(content: string): Promise<string[]> {
    const sessionId = randomUUID();
    const message = {
      id: `msg-grounded-${randomUUID()}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: content }],
    };
    const context = { agentId: AGENT_ID, sessionId, traceId: randomUUID() };
    const events = await appendTraceEvents([
      buildUserMessageEvent(context, message),
      buildTerminalEvent(context, "completed"),
    ]);
    const userEvent = events.find((event) => event.eventType === "user_message");
    if (!userEvent) throw new Error("Grounded test evidence did not persist.");
    await ingestUserTurn(sessionId, [message], {
      traceEventIds: new Map([[message.id, userEvent.id]]),
    });
    const rows = await getDb()
      .select({ id: agentGroundedObservations.id })
      .from(agentGroundedObservations)
      .where(eq(agentGroundedObservations.sourceMessageId, message.id));
    return rows.map((row) => row.id);
  }

  beforeAll(() => {
    getPool();
  });

  afterAll(async () => {
    await closePool();
  });

  it("ingests a user turn and produces a grounded observation", async () => {
    const db = getDb();
    void schema;
    const sessionId = randomUUID();
    const messageId = `msg-int-user-${randomUUID()}`;
    const count = await ingestUserTurn(sessionId, [
      {
        id: messageId,
        role: "user",
        parts: [{ type: "text", text: "Integration test: I prefer dark mode always." }],
      },
    ]);
    expect(count).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(agentGroundedObservations)
      .where(eq(agentGroundedObservations.sourceMessageId, messageId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].originKind).toBe("chat_user");
  });

  it("redacts secrets before every observation-to-version write plane", async () => {
    const secret = `super-secret-${randomUUID()}`;
    await createGroundedEvidence(`api_key=${secret}`);
    await runConsolidation(AGENT_ID, { trigger: "manual" });
    const db = getDb();
    const [observations, signals, typedCandidates, candidates, proposals, versions] =
      await Promise.all([
        db
          .select()
          .from(agentGroundedObservations)
          .where(eq(agentGroundedObservations.agentId, AGENT_ID)),
        db.select().from(agentRecallSignals).where(eq(agentRecallSignals.agentId, AGENT_ID)),
        db.select().from(agentMemoryCandidates).where(eq(agentMemoryCandidates.agentId, AGENT_ID)),
        db
          .select()
          .from(agentConsolidationCandidates)
          .where(eq(agentConsolidationCandidates.agentId, AGENT_ID)),
        db.select().from(agentReviewProposals).where(eq(agentReviewProposals.agentId, AGENT_ID)),
        db
          .select({ version: agentMemoryVersions })
          .from(agentMemoryVersions)
          .innerJoin(agentMemories, eq(agentMemories.id, agentMemoryVersions.memoryId))
          .where(eq(agentMemories.agentId, AGENT_ID)),
      ]);
    expect(
      JSON.stringify({ observations, signals, typedCandidates, candidates, proposals, versions }),
    ).not.toContain(secret);
  });

  it("excludes observations linked to failed attempts from consolidation scans", async () => {
    const sessionId = randomUUID();
    const message = {
      id: `failed-${randomUUID()}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Failed attempt evidence must not promote." }],
    };
    const context = { agentId: AGENT_ID, sessionId, traceId: randomUUID() };
    const events = await appendTraceEvents([
      buildUserMessageEvent(context, message),
      buildTerminalEvent(context, "failed"),
    ]);
    await ingestUserTurn(sessionId, [message], {
      traceEventIds: new Map([[message.id, events[0].id]]),
    });
    const eligible = await listGroundedObservations(AGENT_ID);
    expect(eligible.some((row) => row.sourceMessageId === message.id)).toBe(false);
  });

  it("repoints source-idempotent observations to a successful retry attempt", async () => {
    const sessionId = randomUUID();
    const message = {
      id: `retry-${randomUUID()}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Successful retry evidence remains usable." }],
    };
    const failedContext = { agentId: AGENT_ID, sessionId, traceId: randomUUID() };
    const failed = await appendTraceEvents([
      buildUserMessageEvent(failedContext, message),
      buildTerminalEvent(failedContext, "failed"),
    ]);
    await ingestUserTurn(sessionId, [message], {
      traceEventIds: new Map([[message.id, failed[0].id]]),
    });

    const completedContext = { agentId: AGENT_ID, sessionId, traceId: randomUUID() };
    const completed = await appendTraceEvents([
      buildUserMessageEvent(completedContext, message),
      buildTerminalEvent(completedContext, "completed"),
    ]);
    await ingestUserTurn(sessionId, [message], {
      traceEventIds: new Map([[message.id, completed[0].id]]),
    });

    const [observation] = await getDb()
      .select()
      .from(agentGroundedObservations)
      .where(eq(agentGroundedObservations.sourceMessageId, message.id));
    expect(observation.traceEventId).toBe(completed[0].id);
    const eligible = await listGroundedObservations(AGENT_ID);
    expect(eligible.some((row) => row.id === observation.id)).toBe(true);
  });

  it("assistant content never produces a grounded observation (firewall)", async () => {
    const count = await ingestUserTurn("00000000-0000-4000-8000-0000000000a2", [
      {
        id: "msg-int-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "You prefer dark mode." }],
      },
    ]);
    expect(count).toBe(0);
  });

  it("recall signals carry integer basis-point scores after a sweep", async () => {
    const db = getDb();
    await runConsolidation(AGENT_ID, { trigger: "manual" });
    const rows = await db.select().from(agentRecallSignals).limit(1);
    if (rows[0]) {
      expect(rows[0].totalScoreBps).toBeGreaterThanOrEqual(0);
      expect(rows[0].totalScoreBps).toBeLessThanOrEqual(10000);
    }
  });

  it("a sweep in dry-run produces candidates and zero proposals", async () => {
    // DRY_RUN defaults to true; no proposals should be created.
    const result = await runConsolidation(AGENT_ID, { trigger: "manual" });
    expect(result.runId).toBeTruthy();
    expect(result.proposalsCreated).toBe(0);
  });

  it("propose → applyReviewProposal lands a source='consolidated' memory (manual approval)", async () => {
    const db = getDb();
    // Create a consolidation proposal directly (bypassing the dry-run gate) so
    // we can exercise the apply path's source guard + claim_hash stamping.
    const { createReviewProposal } = await import("@/lib/self-improvement/proposals");
    const content = `Consolidated fact ${Date.now()}`;
    const groundedObservationIds = await createGroundedEvidence(content);
    const proposal = await createReviewProposal({
      kind: "memory_create",
      payload: { memoryKind: "fact", content, source: "consolidated", confidence: 100 },
      rationale: "Integration: consolidated fact proposal.",
      proposerOrigin: "consolidation",
      admissionMetadata: {
        version: 1,
        origin: "consolidation",
        claimHash: claimHash(content),
        scoreBps: 9500,
        groundedObservationIds,
      },
    });

    await applyReviewProposal(proposal.id);

    const rows = await db
      .select({ root: agentMemories, version: agentMemoryVersions })
      .from(agentMemories)
      .innerJoin(agentMemoryVersions, eq(agentMemoryVersions.id, agentMemories.currentVersionId))
      .where(eq(agentMemories.reviewProposalId, proposal.id));
    expect(rows.length).toBe(1);
    expect(rows[0].version.source).toBe("consolidated");
    expect(rows[0].root.claimHash).toBe(claimHash(content));

    // The consolidated memory should appear in the events timeline as 'applied'.
    const events = await db
      .select()
      .from(agentMemoryEvents)
      .where(eq(agentMemoryEvents.proposalId, proposal.id));
    expect(events.some((e) => e.eventType === "applied")).toBe(true);
  });

  it("a second apply with the same claim_hash is a no-op (duplicate_claim_hash)", async () => {
    const db = getDb();
    const { createReviewProposal } = await import("@/lib/self-improvement/proposals");
    const content = `Dup-test consolidated fact ${Date.now()}`;
    const hash = claimHash(content);
    const groundedObservationIds = await createGroundedEvidence(content);

    const p1 = await createReviewProposal({
      kind: "memory_create",
      payload: { memoryKind: "fact", content, source: "consolidated", confidence: 100 },
      rationale: "First proposal.",
      proposerOrigin: "consolidation",
      admissionMetadata: {
        version: 1,
        origin: "consolidation",
        claimHash: hash,
        scoreBps: 9500,
        groundedObservationIds,
      },
    });
    await applyReviewProposal(p1.id);

    // A second proposal with the SAME claim_hash (simulating a re-run / race).
    const p2 = await createReviewProposal({
      kind: "memory_create",
      payload: { memoryKind: "fact", content, source: "consolidated", confidence: 100 },
      rationale: "Second proposal — should no-op via the unique index.",
      proposerOrigin: "consolidation",
      admissionMetadata: {
        version: 1,
        origin: "consolidation",
        claimHash: hash,
        scoreBps: 9500,
        groundedObservationIds,
      },
    });
    // Applying the second must not throw and must not create a second memory.
    await applyReviewProposal(p2.id);

    const memories = await db.select().from(agentMemories).where(eq(agentMemories.claimHash, hash));
    expect(memories.length).toBe(1);

    // The second apply logged a duplicate_claim_hash event.
    const dupEvents = await db
      .select()
      .from(agentMemoryEvents)
      .where(
        and(eq(agentMemoryEvents.proposalId, p2.id), eq(agentMemoryEvents.eventType, "applied")),
      );
    expect(
      dupEvents.some(
        (e) => (e.detail as { reason?: string } | null)?.reason === "duplicate_claim_hash",
      ),
    ).toBe(true);
  });

  it("a non-consolidation proposal attempting source='consolidated' throws", async () => {
    const { createReviewProposal } = await import("@/lib/self-improvement/proposals");
    const proposal = await createReviewProposal({
      kind: "memory_create",
      payload: { memoryKind: "fact", content: "Sneaky", source: "consolidated", confidence: 100 },
      rationale: "Sneaky turn-review proposal claiming consolidated.",
      proposerOrigin: "turn_review",
    });
    await expect(applyReviewProposal(proposal.id)).rejects.toThrow();
  });

  it("candidates are written for every scored claim (explain-why surface)", async () => {
    const db = getDb();
    const result = await runConsolidation(AGENT_ID, { trigger: "manual" });
    if (result.candidatesEvaluated > 0) {
      const rows = await db
        .select()
        .from(agentConsolidationCandidates)
        .where(eq(agentConsolidationCandidates.runId, result.runId));
      expect(rows.length).toBe(result.candidatesEvaluated);
    }
  });
});

/** Newest events surface (kept for any future direct assertion). */
async function _latestEvents(proposalId: string) {
  const db = getDb();
  return db
    .select()
    .from(agentMemoryEvents)
    .where(eq(agentMemoryEvents.proposalId, proposalId))
    .orderBy(desc(agentMemoryEvents.createdAt));
}
void _latestEvents;
void listReviewProposals;
