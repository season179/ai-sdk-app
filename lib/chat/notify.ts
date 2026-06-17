import { sql } from "drizzle-orm";

import { getDb } from "@/db";

/**
 * Postgres LISTEN/NOTIFY channel carrying chat-session append events (K2). Both
 * writers (the chat route and the scheduled-task worker) announce on it after a
 * successful appendSessionMessages; the SSE endpoint
 * (app/api/sessions/[id]/stream) LISTENs and pushes the new turns to open tabs.
 */
export const CHAT_APPEND_CHANNEL = "chat_append";

/**
 * Payload sent on CHAT_APPEND_CHANNEL. Kept tiny (well under the 8 KB NOTIFY
 * limit): the SSE listener re-queries the transcript by ordinal, so only the
 * session id is needed to route a notification to the right open tabs.
 */
export type ChatAppendNotification = { sessionId: string };

/**
 * Announce that one or more turns were appended to a session so any open SSE
 * listener can push them live. Issued via pg_notify — the function form, which
 * accepts a bound parameter, unlike the literal-only `NOTIFY channel, '...'`
 * statement — through the shared pool, since NOTIFY needs no dedicated
 * connection.
 *
 * Callers wrap this fail-soft: a dropped notification only delays a live update
 * until the next poll/reload, it never affects the durable append that already
 * committed. The open tab also dedupes by message id, so a duplicate or
 * already-seen turn is harmless.
 */
export async function notifySessionAppended(sessionId: string): Promise<void> {
  const payload = JSON.stringify({ sessionId } satisfies ChatAppendNotification);
  await getDb().execute(sql`select pg_notify(${CHAT_APPEND_CHANNEL}, ${payload})`);
}
