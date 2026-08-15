import { jsonSchema } from "ai";
import { and, eq, inArray } from "drizzle-orm";

import { type AppDbClient, getDb } from "@/db";
import {
  type AgentMemoryCandidate,
  type AgentTraceEvent,
  agentMemoryCandidates,
  agentMemoryCandidateTraceEvents,
} from "@/db/schema";
import { type GateResult, gateMemoryCandidate } from "@/lib/memory/gate";
import { canonicalJson, sanitizeTracePayload, sha256 } from "@/lib/memory/redaction";

export type ExtractedMemoryCandidate = {
  memoryType: "semantic" | "episodic" | "procedural";
  canonicalKey: string | null;
  content: string;
  structured: Record<string, unknown>;
  evidenceTraceEventIds: string[];
  sourceStance: "observation" | "assertion" | "interpretation" | "evaluation";
  validFrom: string | null;
  validTo: string | null;
  sourceReferenceTime: string | null;
  timePrecision: "instant" | "day" | "month" | "year" | "unknown";
  confidence: number;
  proposedOperation: "ADD" | "UPDATE" | "INVALIDATE" | "NOOP" | "REVIEW";
};

export const memoryCandidateJsonSchema = jsonSchema<ExtractedMemoryCandidate>({
  type: "object",
  properties: {
    memoryType: { type: "string", enum: ["semantic", "episodic", "procedural"] },
    canonicalKey: { type: ["string", "null"] },
    content: { type: "string", maxLength: 2000 },
    structured: { type: "object", additionalProperties: true },
    evidenceTraceEventIds: { type: "array", items: { type: "string" } },
    sourceStance: {
      type: "string",
      enum: ["observation", "assertion", "interpretation", "evaluation"],
    },
    validFrom: { type: ["string", "null"] },
    validTo: { type: ["string", "null"] },
    sourceReferenceTime: { type: ["string", "null"] },
    timePrecision: { type: "string", enum: ["instant", "day", "month", "year", "unknown"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    proposedOperation: { type: "string", enum: ["ADD", "UPDATE", "INVALIDATE", "NOOP", "REVIEW"] },
  },
  required: [
    "memoryType",
    "canonicalKey",
    "content",
    "structured",
    "evidenceTraceEventIds",
    "sourceStance",
    "validFrom",
    "validTo",
    "sourceReferenceTime",
    "timePrecision",
    "confidence",
    "proposedOperation",
  ],
  additionalProperties: false,
});

export type PersistCandidatesInput = {
  agentId: string;
  reviewKey: string;
  traceId: string;
  candidates: ExtractedMemoryCandidate[];
  windowEvents: AgentTraceEvent[];
  extractorId: string;
  modelId: string;
  promptHash: string;
  schemaVersion: number;
  policyVersion: string;
};

export type PersistedCandidateVerdict = {
  candidate: AgentMemoryCandidate;
  gate: GateResult;
  evidenceTraceEventIds: string[];
};

export async function persistMemoryCandidates(
  input: PersistCandidatesInput,
  outerDb?: AppDbClient,
): Promise<PersistedCandidateVerdict[]> {
  const run = async (db: AppDbClient) => {
    const windowById = new Map(input.windowEvents.map((row) => [row.id, row]));
    const output: PersistedCandidateVerdict[] = [];
    for (const draft of input.candidates.slice(0, 8)) {
      const citedEvents = [...new Set(draft.evidenceTraceEventIds)]
        .map((id) => windowById.get(id))
        .filter((row): row is AgentTraceEvent => Boolean(row));
      const gate = gateMemoryCandidate(
        {
          ...draft,
          content: canonicalJson({
            canonicalKey: draft.canonicalKey,
            content: draft.content,
            structured: draft.structured,
          }),
        },
        {
          allWindowEvents: input.windowEvents,
          citedEvents,
        },
      );
      const sanitized = sanitizeTracePayload({
        content: draft.content,
        structured: draft.structured,
      });
      const contentHash = sha256(
        canonicalJson({
          memoryType: draft.memoryType,
          canonicalKey: draft.canonicalKey,
          content: sanitized.payload,
          evidenceTraceEventIds: [...new Set(draft.evidenceTraceEventIds)].sort(),
          proposedOperation: draft.proposedOperation,
        }),
      );
      const validDuring = toRange(draft.validFrom, draft.validTo);
      const values = {
        agentId: input.agentId,
        reviewKey: input.reviewKey,
        traceId: input.traceId,
        memoryType: draft.memoryType,
        canonicalKey:
          gate.status === "accepted" ? draft.canonicalKey?.trim().slice(0, 500) || null : null,
        content: gate.status === "accepted" ? draft.content.trim().slice(0, 2000) : null,
        structured: gate.status === "accepted" ? draft.structured : {},
        sourceStance: draft.sourceStance,
        validDuring,
        sourceReferenceTime:
          draft.sourceReferenceTime && !Number.isNaN(Date.parse(draft.sourceReferenceTime))
            ? new Date(draft.sourceReferenceTime)
            : null,
        timePrecision: draft.timePrecision,
        confidence: draft.confidence,
        proposedOperation: draft.proposedOperation,
        gateStatus: gate.status,
        gateReason: gate.reason,
        scoreBps: gate.scoreBps,
        contentHash,
        extractorId: input.extractorId,
        modelId: input.modelId,
        promptHash: input.promptHash,
        schemaVersion: input.schemaVersion,
        policyVersion: input.policyVersion,
      };
      const inserted = await db
        .insert(agentMemoryCandidates)
        .values(values)
        .onConflictDoNothing()
        .returning();
      const candidate =
        inserted[0] ??
        (
          await db
            .select()
            .from(agentMemoryCandidates)
            .where(
              and(
                eq(agentMemoryCandidates.agentId, input.agentId),
                eq(agentMemoryCandidates.reviewKey, input.reviewKey),
                eq(agentMemoryCandidates.extractorId, input.extractorId),
                eq(agentMemoryCandidates.contentHash, contentHash),
              ),
            )
            .limit(1)
        )[0];
      if (!candidate) throw new Error("Candidate persistence did not return an idempotent row.");
      if (citedEvents.length > 0) {
        await db
          .insert(agentMemoryCandidateTraceEvents)
          .values(
            citedEvents.map((event, index) => ({
              candidateId: candidate.id,
              eventId: event.id,
              sourceRole: index === 0 ? ("primary" as const) : ("context" as const),
            })),
          )
          .onConflictDoNothing();
      }
      output.push({
        candidate,
        gate,
        evidenceTraceEventIds: citedEvents.map((event) => event.id),
      });
    }
    return output;
  };
  return outerDb ? run(outerDb) : getDb().transaction(run);
}

export async function listAcceptedCandidatesByReviewKey(
  agentId: string,
  reviewKey: string,
  db: AppDbClient = getDb(),
) {
  return db
    .select()
    .from(agentMemoryCandidates)
    .where(
      and(
        eq(agentMemoryCandidates.agentId, agentId),
        eq(agentMemoryCandidates.reviewKey, reviewKey),
        eq(agentMemoryCandidates.gateStatus, "accepted"),
      ),
    );
}

export async function getCandidateEvidenceIds(
  candidateIds: string[],
  db: AppDbClient = getDb(),
): Promise<Map<string, string[]>> {
  if (candidateIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(agentMemoryCandidateTraceEvents)
    .where(inArray(agentMemoryCandidateTraceEvents.candidateId, candidateIds));
  const out = new Map<string, string[]>();
  for (const row of rows)
    out.set(row.candidateId, [...(out.get(row.candidateId) ?? []), row.eventId]);
  return out;
}

function toRange(from: string | null, to: string | null): string | null {
  if (!from && !to) return null;
  return `[${from ? new Date(from).toISOString() : ""},${to ? new Date(to).toISOString() : ""})`;
}
