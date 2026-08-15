import { getDb } from "@/db";
import {
  type AdmissionMetadata,
  agentMemoryEvents,
  type MemoryEventDetail,
  type MemoryEventOrigin,
  type MemoryEventType,
  type NewAgentMemoryEvent,
} from "@/db/schema";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/**
 * Append to agent_memory_events — the human-facing timeline ("see the
 * evolution", §9.1). Append-only and NEVER read back into evidence. Do not log
 * memory_search usage here (usage ≠ evolution).
 *
 * Fail-soft by design: the timeline is observability, not a correctness gate.
 * A logging failure must never break the writer that called it.
 */
export async function recordMemoryEvent(
  input: {
    agentId?: string;
    eventType: MemoryEventType;
    origin: MemoryEventOrigin;
    summary: string;
    memoryId?: string | null;
    memoryVersionId?: string | null;
    proposalId?: string | null;
    runId?: string | null;
    detail?: MemoryEventDetail | null;
  },
  db = getDb(),
): Promise<void> {
  const agentId = input.agentId ?? DEFAULT_AGENT_ID;
  const value: NewAgentMemoryEvent = {
    agentId,
    eventType: input.eventType,
    origin: input.origin,
    summary: input.summary,
    memoryId: input.memoryId ?? null,
    memoryVersionId: input.memoryVersionId ?? null,
    proposalId: input.proposalId ?? null,
    runId: input.runId ?? null,
    detail: input.detail ?? null,
  };

  try {
    await db.transaction(async (savepoint) => {
      await savepoint.insert(agentMemoryEvents).values(value);
    });
  } catch (error) {
    console.error("recordMemoryEvent failed", { eventType: input.eventType, error });
  }
}

/** Helper: build the `detail` shape for an applied-proposal event. */
export function appliedEventDetail(
  admissionMetadata?: AdmissionMetadata | null,
  reason?: string,
): MemoryEventDetail {
  return {
    version: 1,
    admissionMetadata: admissionMetadata ?? undefined,
    reason,
  };
}
