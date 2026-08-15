import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentConsolidationCandidates,
  agentConsolidationRuns,
  agentConsolidationSettings,
  agentMemoryCandidates,
  agentMemoryCandidateTraceEvents,
  agentReviewProposals,
  agentTraceEvents,
} from "@/db/schema";
import { admitTurnReviewCandidates } from "@/lib/consolidation/run";
import { buildTerminalEvent, buildUserMessageEvent } from "@/lib/memory/capture";
import {
  type ExtractedMemoryCandidate,
  persistMemoryCandidates,
} from "@/lib/memory/candidates";
import { appendTraceEvents } from "@/lib/memory/trace";
import { closePool, getPool } from "@/lib/scheduler/db";

const available = Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("typed trace distillation (integration)", () => {
  const agentId = randomUUID();
  beforeAll(async () => {
    getPool();
    await getDb().insert(agentConsolidationSettings).values({
      agentId,
      enabled: true,
      dryRun: false,
      autoApplyEnabled: false,
    });
  });
  afterAll(async () => {
    const db = getDb();
    await db.delete(agentReviewProposals).where(eq(agentReviewProposals.agentId, agentId));
    await db.delete(agentConsolidationRuns).where(eq(agentConsolidationRuns.agentId, agentId));
    const candidates = await db
      .select({ id: agentMemoryCandidates.id })
      .from(agentMemoryCandidates)
      .where(eq(agentMemoryCandidates.agentId, agentId));
    for (const candidate of candidates) {
      await db
        .delete(agentMemoryCandidateTraceEvents)
        .where(eq(agentMemoryCandidateTraceEvents.candidateId, candidate.id));
    }
    await db.delete(agentMemoryCandidates).where(eq(agentMemoryCandidates.agentId, agentId));
    await db.delete(agentTraceEvents).where(eq(agentTraceEvents.agentId, agentId));
    await db.delete(agentConsolidationSettings).where(eq(agentConsolidationSettings.agentId, agentId));
    await closePool();
  });

  async function window(status: "completed" | "failed" = "completed") {
    const traceId = randomUUID();
    const sessionId = randomUUID();
    const message = {
      id: `msg-${randomUUID()}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "I prefer concise status updates." }],
    };
    const context = { agentId, traceId, sessionId };
    const rows = await appendTraceEvents([
      buildUserMessageEvent(context, message),
      buildTerminalEvent(context, status),
    ]);
    return { traceId, rows };
  }

  function draft(evidenceTraceEventIds: string[], overrides: Partial<ExtractedMemoryCandidate> = {}): ExtractedMemoryCandidate {
    return {
      memoryType: "semantic",
      canonicalKey: "preference:status-style",
      content: "The user prefers concise status updates.",
      structured: { memoryKind: "preference" },
      evidenceTraceEventIds,
      sourceStance: "assertion",
      validFrom: null,
      validTo: null,
      sourceReferenceTime: null,
      timePrecision: "unknown",
      confidence: 100,
      proposedOperation: "ADD",
      ...overrides,
    };
  }

  it("persists, gates, admits, and idempotently proposes a completed candidate", async () => {
    const evidence = await window();
    const input = {
      agentId,
      reviewKey: `review:${randomUUID()}`,
      traceId: evidence.traceId,
      candidates: [draft(evidence.rows.map((row) => row.id))],
      windowEvents: evidence.rows,
      extractorId: "integration-extractor",
      modelId: "integration-model",
      promptHash: "integration-prompt",
      schemaVersion: 1,
      policyVersion: "write-v1",
    };
    const first = await persistMemoryCandidates(input);
    expect(first[0].candidate.gateStatus).toBe("accepted");
    const admitted = await admitTurnReviewCandidates({ agentId, candidates: first });
    expect(admitted.proposed).toBe(1);

    const retry = await persistMemoryCandidates(input);
    await admitTurnReviewCandidates({ agentId, candidates: retry });
    const proposals = await getDb()
      .select()
      .from(agentReviewProposals)
      .where(eq(agentReviewProposals.sourceCandidateId, first[0].candidate.id));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].admissionPolicy).toBe("human_review");
  });

  it("never stores a rejected secret body and never proposes failed traces", async () => {
    const completed = await window();
    const secret = "api_key=super-secret-value";
    const secretRows = await persistMemoryCandidates({
      agentId,
      reviewKey: `review:${randomUUID()}`,
      traceId: completed.traceId,
      candidates: [draft(completed.rows.map((row) => row.id), { content: secret })],
      windowEvents: completed.rows,
      extractorId: "integration-extractor",
      modelId: "integration-model",
      promptHash: "integration-prompt",
      schemaVersion: 1,
      policyVersion: "write-v1",
    });
    expect(secretRows[0].candidate.content).toBeNull();
    expect(JSON.stringify(secretRows[0].candidate)).not.toContain("super-secret-value");

    const failed = await window("failed");
    const failedRows = await persistMemoryCandidates({
      agentId,
      reviewKey: `review:${randomUUID()}`,
      traceId: failed.traceId,
      candidates: [draft(failed.rows.map((row) => row.id))],
      windowEvents: failed.rows,
      extractorId: "integration-extractor",
      modelId: "integration-model",
      promptHash: "integration-prompt",
      schemaVersion: 1,
      policyVersion: "write-v1",
    });
    expect(failedRows[0].candidate.gateReason).toBe("trace_not_completed");
    const admitted = await admitTurnReviewCandidates({ agentId, candidates: failedRows });
    expect(admitted.proposed).toBe(0);
  });
});
