/**
 * Helpers for reconciling chat message lists by id.
 *
 * Two async writers feed the UI's message state — the AI SDK's own streaming
 * and the SSE/poll live-merge (see lib/chat/notify.ts) — so the same turn can
 * briefly arrive from both before they reconcile. React crashes on duplicate
 * list keys, so id-uniqueness has to be enforced at the read/merge boundaries.
 * Centralizing the Set-based bookkeeping here keeps each call site from
 * re-implementing it.
 */

/** Minimal shape these helpers need: anything carrying a string id. */
type MessageLike = { id: string };

/**
 * Return the messages with each id appearing once, keeping the first
 * occurrence so every message stays at the position where it first appeared.
 * Use this at the render boundary so React always sees unique keys.
 */
export function dedupeMessagesById<T extends MessageLike>(messages: T[]): T[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false;
    }
    seen.add(message.id);
    return true;
  });
}

/**
 * Append the incoming messages whose id is not already present in `current`,
 * preserving incoming order. Returns the existing `current` reference unchanged
 * when nothing new is added so React can bail out of the re-render. Incoming
 * messages without an id are skipped.
 */
export function appendNewMessagesById<T extends MessageLike>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((message) => message.id));
  const additions = incoming.filter((message) => message.id && !seen.has(message.id));
  return additions.length === 0 ? current : [...current, ...additions];
}
