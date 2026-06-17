import { Client } from "pg";

import { CHAT_APPEND_CHANNEL, type ChatAppendNotification } from "@/lib/chat/notify";
import { getChatSession, getSessionMaxOrdinal, getSessionMessagesAfter } from "@/lib/chat/sessions";
import { requireDatabaseUrl } from "@/lib/scheduler/env";
import { isUuid } from "@/lib/utils";

// A dedicated pg Client holding a LISTEN connection needs the Node runtime, and
// the stream must never be cached — it's a live, per-connection event source.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** Comment heartbeat so idle proxies/load-balancers don't reap the connection. */
const HEARTBEAT_MS = 25_000;

/**
 * GET /api/sessions/:id/stream — Server-Sent Events of turns appended to a
 * session (K2). Opens a dedicated Postgres client, LISTENs on CHAT_APPEND_CHANNEL,
 * and on each matching NOTIFY queries turns past its high-water mark and emits
 * them as `event: message` frames. Both writers (chat route, worker) fire the
 * NOTIFY after a successful append, so the open chat updates without a reload.
 *
 * Baseline: the optional `?since=<ordinal>` query param is the client's current
 * high-water mark; absent, it defaults to the session's current max so a fresh
 * subscriber receives only future turns. The connect-time drain covers the race
 * where a turn lands between the client's load and this connection.
 */
export async function GET(req: Request, context: RouteContext) {
  const { id: sessionId } = await context.params;

  if (!isUuid(sessionId)) {
    return Response.json({ error: "Session id must be a UUID." }, { status: 400 });
  }

  // 404 a missing/deleted session so the client stops retrying a dead stream.
  const session = await getChatSession(sessionId);
  if (!session) {
    return Response.json(
      { error: `No chat session with id '${sessionId}' was found.` },
      { status: 404 },
    );
  }

  const sinceParam = new URL(req.url).searchParams.get("since");
  const parsedSince = sinceParam != null ? Number.parseInt(sinceParam, 10) : Number.NaN;
  let lastOrdinal = Number.isInteger(parsedSince)
    ? parsedSince
    : await getSessionMaxOrdinal(sessionId);

  const encoder = new TextEncoder();
  const client = new Client({ connectionString: requireDatabaseUrl() });

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  // Serialize NOTIFY-driven drains: `draining` blocks re-entry, `pending`
  // re-triggers once more after a drain so a NOTIFY arriving mid-query isn't lost.
  let draining = false;
  let pending = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed by a concurrent cleanup; ignore.
        }
      };

      const cleanup = async () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        req.signal.removeEventListener("abort", onAbort);
        try {
          await client.end();
        } catch {
          // Client may never have connected or already be closed.
        }
        try {
          controller.close();
        } catch {
          // Controller may already be closed.
        }
      };

      const onAbort = () => {
        void cleanup();
      };

      const drain = async () => {
        if (draining) {
          pending = true;
          return;
        }
        draining = true;
        try {
          do {
            pending = false;
            for (;;) {
              const rows = await getSessionMessagesAfter(sessionId, lastOrdinal);
              if (rows.length === 0) break;
              for (const { ordinal, message } of rows) {
                send(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
                lastOrdinal = Math.max(lastOrdinal, ordinal);
              }
            }
          } while (pending);
        } catch (error) {
          console.error(`SSE drain for session ${sessionId} failed`, error);
        } finally {
          draining = false;
        }
      };

      // Register abort handling before any await so an early disconnect can't
      // strand the LISTEN client.
      req.signal.addEventListener("abort", onAbort);
      if (req.signal.aborted) {
        await cleanup();
        return;
      }

      try {
        await client.connect();
        client.on("notification", (msg) => {
          if (!msg.payload) return;
          let parsed: ChatAppendNotification | null = null;
          try {
            parsed = JSON.parse(msg.payload) as ChatAppendNotification;
          } catch {
            parsed = null;
          }
          if (parsed?.sessionId === sessionId) {
            void drain();
          }
        });
        client.on("error", (error) => {
          console.error(`SSE listener client error for session ${sessionId}`, error);
          void cleanup();
        });
        await client.query(`LISTEN ${CHAT_APPEND_CHANNEL}`);
      } catch (error) {
        console.error(`SSE LISTEN setup for session ${sessionId} failed`, error);
        await cleanup();
        return;
      }

      // Open the stream, then flush anything that landed between the client's
      // load and this connection.
      send(": connected\n\n");
      await drain();

      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
    },
    async cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      try {
        await client.end();
      } catch {
        // Already closed.
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx) so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
