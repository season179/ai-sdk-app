import { randomUUID } from "node:crypto";

import type { StepResult } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentConsolidationCandidates,
  agentConsolidationRuns,
  agentConsolidationSettings,
  agentMemories,
  agentMemoryCandidates,
  agentMemoryCandidateTraceEvents,
  agentMemoryEvents,
  agentMemoryVersions,
  agentMemoryVersionTraceEvents,
  agentReviewProposals,
  agentTraceEvents,
} from "@/db/schema";
import { admitTurnReviewCandidates } from "@/lib/consolidation/run";
import { type ExtractedMemoryCandidate, persistMemoryCandidates } from "@/lib/memory/candidates";
import {
  buildTerminalEvent,
  buildUserMessageEvent,
  mapStepToTraceEvents,
} from "@/lib/memory/capture";
import { appendTraceEvents } from "@/lib/memory/trace";
import { closePool, getPool } from "@/lib/scheduler/db";
import { applyReviewProposal } from "@/lib/self-improvement/apply";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
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
    await db
      .delete(agentConsolidationSettings)
      .where(eq(agentConsolidationSettings.agentId, agentId));
    await closePool();
  });

  async function window(
    status: "completed" | "failed" = "completed",
    text = "I prefer concise status updates.",
  ) {
    const traceId = randomUUID();
    const sessionId = randomUUID();
    const message = {
      id: `msg-${randomUUID()}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text }],
    };
    const context = { agentId, traceId, sessionId };
    const rows = await appendTraceEvents([
      buildUserMessageEvent(context, message),
      buildTerminalEvent(context, status),
    ]);
    return { traceId, rows };
  }

  function draft(
    evidenceTraceEventIds: string[],
    overrides: Partial<ExtractedMemoryCandidate> = {},
  ): ExtractedMemoryCandidate {
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
    const [proposal] = await getDb()
      .select()
      .from(agentReviewProposals)
      .where(eq(agentReviewProposals.sourceCandidateId, first[0].candidate.id));
    await applyReviewProposal(proposal.id);

    const retry = await persistMemoryCandidates(input);
    await admitTurnReviewCandidates({ agentId, candidates: retry });
    const proposals = await getDb()
      .select()
      .from(agentReviewProposals)
      .where(eq(agentReviewProposals.sourceCandidateId, first[0].candidate.id));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].admissionPolicy).toBe("human_review");
    const [root] = await getDb()
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.reviewProposalId, proposal.id));
    expect(root.currentVersionId).toBeTruthy();
    const versions = await getDb()
      .select()
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.memoryId, root.id));
    expect(versions).toHaveLength(1);
    const provenance = await getDb()
      .select()
      .from(agentMemoryVersionTraceEvents)
      .where(eq(agentMemoryVersionTraceEvents.memoryVersionId, root.currentVersionId as string));
    expect(provenance.length).toBeGreaterThan(0);
  });

  it("never admits recalled memory content cited as fresh evidence", async () => {
    const traceId = randomUUID();
    const context = { agentId, traceId, sessionId: randomUUID() };
    const recalledContent = "The user prefers recalled-only deployment settings.";
    const step = {
      callId: "recall-call",
      stepNumber: 1,
      model: { provider: "test", modelId: "test" },
      text: "",
      toolCalls: [
        { toolCallId: "memory-call", toolName: "memory_search", input: { query: "deployment" } },
      ],
      toolResults: [
        {
          toolCallId: "memory-call",
          toolName: "memory_search",
          output: { memories: [{ content: recalledContent }] },
        },
      ],
      finishReason: "tool-calls",
      rawFinishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      request: {},
      response: {},
      content: [],
    } as unknown as StepResult<any>;
    const rows = await appendTraceEvents([
      ...mapStepToTraceEvents(context, step),
      buildTerminalEvent(context, "completed"),
    ]);
    const recalled = rows.find((row) => row.eventType === "tool_result");
    expect(recalled).toMatchObject({
      trustClass: "third_party_content",
      payload: { derivative: true },
    });
    const persisted = await persistMemoryCandidates({
      agentId,
      reviewKey: `review:${randomUUID()}`,
      traceId,
      candidates: [
        draft([recalled?.id ?? "missing"], {
          canonicalKey: `preference:recalled-${randomUUID()}`,
          content: recalledContent,
        }),
      ],
      windowEvents: rows,
      extractorId: "integration-extractor",
      modelId: "integration-model",
      promptHash: "integration-prompt",
      schemaVersion: 1,
      policyVersion: "write-v1",
    });
    expect(persisted[0].candidate).toMatchObject({
      gateStatus: "rejected",
      gateReason: "derivative_retrieval_primary_evidence",
    });
    expect((await admitTurnReviewCandidates({ agentId, candidates: persisted })).proposed).toBe(0);
  });

  it("promotes strict evidence sensitivity into version one without the secret", async () => {
    const evidence = await window("completed", "api_key=super-secret-value");
    const persisted = await persistMemoryCandidates({
      agentId,
      reviewKey: `review:${randomUUID()}`,
      traceId: evidence.traceId,
      candidates: [
        draft(
          evidence.rows.map((row) => row.id),
          {
            canonicalKey: `fact:sensitive-${randomUUID()}`,
            content: "The user configured a private integration credential.",
            structured: { memoryKind: "fact", category: "integration" },
          },
        ),
      ],
      windowEvents: evidence.rows,
      extractorId: "integration-extractor",
      modelId: "integration-model",
      promptHash: "integration-prompt",
      schemaVersion: 1,
      policyVersion: "write-v1",
    });
    expect(persisted[0].sensitivityClass).toBe("sensitive");
    await admitTurnReviewCandidates({ agentId, candidates: persisted });
    const [proposal] = await getDb()
      .select()
      .from(agentReviewProposals)
      .where(eq(agentReviewProposals.sourceCandidateId, persisted[0].candidate.id));
    await applyReviewProposal(proposal.id);
    const [root] = await getDb()
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.reviewProposalId, proposal.id));
    const [version] = await getDb()
      .select()
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.id, root.currentVersionId as string));
    expect(version.sensitivityClass).toBe("sensitive");
    expect(JSON.stringify({ proposal, version })).not.toContain("super-secret-value");
  });

  it("dispatches UPDATE and INVALIDATE to the locked canonical root", async () => {
    const canonicalKey = `preference:dispatch-${randomUUID()}`;
    const applyCandidate = async (
      operation: "ADD" | "UPDATE" | "INVALIDATE",
      content: string,
      structured: Record<string, unknown>,
    ) => {
      const evidence = await window();
      const persisted = await persistMemoryCandidates({
        agentId,
        reviewKey: `review:${randomUUID()}`,
        traceId: evidence.traceId,
        candidates: [
          draft(
            evidence.rows.map((row) => row.id),
            {
              canonicalKey,
              content,
              structured: { memoryKind: "preference", ...structured },
              proposedOperation: operation,
            },
          ),
        ],
        windowEvents: evidence.rows,
        extractorId: "integration-extractor",
        modelId: "integration-model",
        promptHash: "integration-prompt",
        schemaVersion: 1,
        policyVersion: "write-v1",
      });
      const admitted = await admitTurnReviewCandidates({ agentId, candidates: persisted });
      expect(admitted.proposed).toBe(1);
      const [proposal] = await getDb()
        .select()
        .from(agentReviewProposals)
        .where(eq(agentReviewProposals.sourceCandidateId, persisted[0].candidate.id));
      await applyReviewProposal(proposal.id);
    };

    await applyCandidate("ADD", "Initial canonical preference.", { revision: 1 });
    await applyCandidate("UPDATE", "Updated canonical preference.", { revision: 2 });
    const [root] = await getDb()
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.canonicalKey, canonicalKey));
    const versionsAfterUpdate = await getDb()
      .select()
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.memoryId, root.id))
      .orderBy(agentMemoryVersions.versionNo);
    expect(versionsAfterUpdate).toHaveLength(2);
    expect(versionsAfterUpdate[1].content).toBe("Updated canonical preference.");
    expect(versionsAfterUpdate[1].structured).toMatchObject({ revision: 2 });

    await applyCandidate("INVALIDATE", "Invalidate canonical preference.", { revision: 3 });
    const [archived] = await getDb()
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.id, root.id));
    expect(archived.status).toBe("archived");
    const versions = await getDb()
      .select()
      .from(agentMemoryVersions)
      .where(eq(agentMemoryVersions.memoryId, root.id))
      .orderBy(agentMemoryVersions.versionNo);
    expect(versions.at(-1)?.operation).toBe("INVALIDATE");
  });

  it("never stores a rejected secret body and never proposes failed traces", async () => {
    const completed = await window();
    const secret = "api_key=super-secret-value";
    const secretRows = await persistMemoryCandidates({
      agentId,
      reviewKey: `review:${randomUUID()}`,
      traceId: completed.traceId,
      candidates: [
        draft(
          completed.rows.map((row) => row.id),
          { content: secret },
        ),
      ],
      windowEvents: completed.rows,
      extractorId: "integration-extractor",
      modelId: "integration-model",
      promptHash: "integration-prompt",
      schemaVersion: 1,
      policyVersion: "write-v1",
    });
    expect(secretRows[0].candidate.content).toBeNull();
    expect(JSON.stringify(secretRows[0].candidate)).not.toContain("super-secret-value");

    const malformedRows = await persistMemoryCandidates({
      agentId,
      reviewKey: `review:${randomUUID()}`,
      traceId: completed.traceId,
      candidates: [
        draft(
          completed.rows.map((row) => row.id),
          { validFrom: "next someday" },
        ),
      ],
      windowEvents: completed.rows,
      extractorId: "integration-extractor",
      modelId: "integration-model",
      promptHash: "integration-prompt",
      schemaVersion: 1,
      policyVersion: "write-v1",
    });
    expect(malformedRows[0].candidate.gateReason).toBe("malformed_validity_interval");
    expect(malformedRows[0].candidate.validDuring).toBeNull();

    const unresolvedRows = await persistMemoryCandidates({
      agentId,
      reviewKey: `review:${randomUUID()}`,
      traceId: completed.traceId,
      candidates: [
        draft(
          completed.rows.map((row) => row.id),
          {
            canonicalKey: null,
            proposedOperation: "UPDATE",
          },
        ),
      ],
      windowEvents: completed.rows,
      extractorId: "integration-extractor",
      modelId: "integration-model",
      promptHash: "integration-prompt",
      schemaVersion: 1,
      policyVersion: "write-v1",
    });
    expect(unresolvedRows[0].candidate.gateReason).toBe("canonical_target_required");
    expect(
      (await admitTurnReviewCandidates({ agentId, candidates: unresolvedRows })).proposed,
    ).toBe(0);

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
