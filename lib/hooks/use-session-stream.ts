"use client";

import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

import { POLL_FAST_MS, useSmartPoll } from "@/lib/hooks/use-smart-poll";
import type { ChatMessageMetadata } from "@/lib/token-usage";

type LiveMessage = UIMessage<ChatMessageMetadata>;
type SessionPayload = { messages?: LiveMessage[] };

/**
 * Consecutive transient EventSource errors (browser still reconnecting) tolerated
 * before abandoning the stream for the poll fallback. A delivered frame or a
 * successful (re)open resets the count.
 */
const MAX_STREAM_FAILURES = 3;

/**
 * Live session updates (Phase 3.2 / K2). Subscribes to the
 * `/api/sessions/:id/stream` SSE endpoint and pushes each appended turn up via
 * `onMessages`; the caller dedupes by message id (the open tab already holds its
 * own turns locally, and a NOTIFY-driven re-drain can re-deliver a turn).
 *
 * Resilience: EventSource auto-reconnects transient drops on its own. If it
 * gives up (a non-2xx response closes it, or several reconnects fail in a row)
 * the hook falls back to `useSmartPoll` against `GET /api/sessions/:id`, which
 * returns the full transcript for the same dedupe-by-id merge. Each session id
 * gets a fresh attempt at the cheaper stream before any fallback.
 */
export function useSessionStream(
  sessionId: string | null,
  onMessages: (incoming: LiveMessage[]) => void,
): void {
  // Keep the latest callback in a ref so the subscription effect doesn't
  // resubscribe (tear down + reopen the stream) on every parent render.
  const onMessagesRef = useRef(onMessages);
  onMessagesRef.current = onMessages;

  // The session the stream has given up on (and now polls). Deriving the flag
  // from this — rather than a boolean reset on every session change — means a new
  // session id automatically retries the cheaper stream first, with no extra
  // effect to keep in sync.
  const [fallbackFor, setFallbackFor] = useState<string | null>(null);
  const pollFallback = sessionId != null && fallbackFor === sessionId;

  useEffect(() => {
    if (!sessionId || pollFallback) {
      return;
    }
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    let source: EventSource | null = new EventSource(`/api/sessions/${sessionId}/stream`);
    let failures = 0;

    const handleMessage = (event: MessageEvent<string>) => {
      failures = 0;
      try {
        const message = JSON.parse(event.data) as LiveMessage;
        if (message?.id) {
          onMessagesRef.current([message]);
        }
      } catch {
        // Ignore a malformed frame; the next NOTIFY re-drains from the server's
        // high-water mark, so nothing is permanently lost.
      }
    };

    const handleOpen = () => {
      failures = 0;
    };

    const handleError = () => {
      if (!source) {
        return;
      }
      // CLOSED means the browser won't reconnect (e.g. a non-2xx response or an
      // unsupported content type) — fall back to polling at once. CONNECTING
      // means it's retrying a transient drop; tolerate a few before giving up.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        source = null;
        setFallbackFor(sessionId);
        return;
      }
      failures += 1;
      if (failures >= MAX_STREAM_FAILURES) {
        source.close();
        source = null;
        setFallbackFor(sessionId);
      }
    };

    source.addEventListener("message", handleMessage);
    source.addEventListener("open", handleOpen);
    source.addEventListener("error", handleError);

    return () => {
      source?.removeEventListener("message", handleMessage);
      source?.removeEventListener("open", handleOpen);
      source?.removeEventListener("error", handleError);
      source?.close();
      source = null;
    };
  }, [sessionId, pollFallback]);

  const fetcher = useCallback(async (): Promise<SessionPayload> => {
    const response = await fetch(`/api/sessions/${sessionId}`);
    if (!response.ok) {
      throw new Error(`Session fetch failed: ${response.status}`);
    }
    return (await response.json()) as SessionPayload;
  }, [sessionId]);

  const { data } = useSmartPoll<SessionPayload>({
    fetcher,
    getDelayMs: () => POLL_FAST_MS,
    enabled: pollFallback && Boolean(sessionId),
    errorMessage: "Session poll failed.",
  });

  useEffect(() => {
    if (data?.messages?.length) {
      onMessagesRef.current(data.messages);
    }
  }, [data]);
}
