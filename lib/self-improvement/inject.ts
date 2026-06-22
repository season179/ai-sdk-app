import { getSnapshot, renderMemoryBlock } from "@/lib/consolidation/snapshots";
import { isSelfImprovementEnabled } from "@/lib/self-improvement/config";
import { listApprovedMemories } from "@/lib/self-improvement/memories";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/**
 * Load the declarative-memory block for the system prompt.
 *
 * Two-state (§3c): when a sessionId is supplied and a frozen snapshot exists
 * for it, render from the snapshot so the in-session prompt is frozen across
 * POSTs — durable writes affect the NEXT session's snapshot, not this one. When
 * no snapshot exists (session predates snapshots, or snapshot materialization
 * failed), fall back to the live query so the feature degrades gracefully and
 * is a no-op when the flag is off.
 */
export async function loadMemoryBlock(agentId: string = DEFAULT_AGENT_ID, sessionId?: string) {
  if (!isSelfImprovementEnabled()) {
    return "";
  }

  if (sessionId) {
    const frozen = await getSnapshot(sessionId).catch(() => null);
    if (frozen !== null) {
      return frozen;
    }
  }

  const memories = await listApprovedMemories(agentId);
  return renderMemoryBlock(memories);
}
