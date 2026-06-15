"use client";

import type { UIMessage } from "ai";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { ChatSurface } from "@/components/chat/chat-surface";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { type ChatUsageSummary, TokenUsageMenu } from "@/components/chat/token-usage-menu";
import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";
import type { ChatSessionSummary } from "@/lib/chat/sessions";
import type { ChatMessageMetadata } from "@/lib/token-usage";
import { isUuid } from "@/lib/utils";

type ChatMessage = UIMessage<ChatMessageMetadata>;
type ActiveSession = { id: string; messages: ChatMessage[] };
type SidebarStyle = CSSProperties & { "--sidebar-width": string; "--sidebar-rail": string };

const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_RAIL = "3.5rem";
const MOBILE_QUERY = "(max-width: 639px)";
// Pick up the async, server-side title write that lands shortly after a stream ends.
const TITLE_REFRESH_DELAY_MS = 1500;

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
}

/** Fetch a session's messages; null means gone (404) or unreachable. */
async function fetchSessionMessages(id: string): Promise<ChatMessage[] | null> {
  try {
    const response = await fetch(`/api/sessions/${id}`);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { messages?: ChatMessage[] };
    return Array.isArray(data.messages) ? data.messages : [];
  } catch {
    return null;
  }
}

async function fetchSessionList(): Promise<ChatSessionSummary[]> {
  try {
    const response = await fetch("/api/sessions");

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { sessions?: ChatSessionSummary[] };
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

export default function ChatPage() {
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatBusy, setChatBusy] = useState(false);
  const [usage, setUsage] = useState<ChatUsageSummary>({ sessionUsage: {} });
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const booted = useRef(false);

  const activeId = active?.id ?? null;

  const refreshSessions = useCallback(async () => {
    setSessions(await fetchSessionList());
  }, []);

  // Boot once: load the list, then open ?c= / most-recent / a fresh session.
  // A 404 on ?c= is ambiguous (never-saved vs soft-deleted), so we never reuse
  // that id — we mint a fresh one — to avoid hidden-appending to a deleted chat.
  useEffect(() => {
    if (booted.current) {
      return;
    }
    booted.current = true;

    if (isMobileViewport()) {
      setSidebarOpen(false);
    }

    (async () => {
      const list = await fetchSessionList();
      setSessions(list);
      setSessionsLoading(false);

      const requested = new URLSearchParams(window.location.search).get("c");
      if (requested && isUuid(requested)) {
        const messages = await fetchSessionMessages(requested);
        if (messages) {
          setActive({ id: requested, messages });
          return;
        }
      }

      const mostRecentId = list[0]?.id;
      if (mostRecentId) {
        const messages = await fetchSessionMessages(mostRecentId);
        if (messages) {
          setActive({ id: mostRecentId, messages });
          return;
        }
      }

      setActive({ id: crypto.randomUUID(), messages: [] });
    })();
  }, []);

  // Keep ?c= in sync without a navigation, so reloads and bookmarks resume.
  useEffect(() => {
    if (activeId && typeof window !== "undefined") {
      window.history.replaceState(null, "", `/?c=${activeId}`);
    }
  }, [activeId]);

  useEffect(
    () => () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
      }
    },
    [],
  );

  const closeSidebarOnMobile = useCallback(() => {
    if (isMobileViewport()) {
      setSidebarOpen(false);
    }
  }, []);

  const selectSession = useCallback(
    async (id: string) => {
      closeSidebarOnMobile();

      // Never swap the transcript out from under an in-flight stream.
      if (chatBusy || id === activeId) {
        return;
      }

      const messages = await fetchSessionMessages(id);
      if (messages) {
        setActive({ id, messages });
      } else {
        // Vanished between list and click — reconcile the sidebar.
        refreshSessions();
      }
    },
    [chatBusy, activeId, closeSidebarOnMobile, refreshSessions],
  );

  const startNewSession = useCallback(() => {
    if (chatBusy) {
      return;
    }

    closeSidebarOnMobile();
    // Not persisted until the first reply finishes, so it isn't in the list yet.
    setActive({ id: crypto.randomUUID(), messages: [] });
  }, [chatBusy, closeSidebarOnMobile]);

  const renameSession = useCallback(
    async (id: string, title: string) => {
      setSessions((prev) =>
        prev.map((session) => (session.id === id ? { ...session, title } : session)),
      );

      try {
        await fetch(`/api/sessions/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        });
      } catch {
        // refreshSessions below restores server truth on failure.
      }

      refreshSessions();
    },
    [refreshSessions],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      // Deleting the session that is actively streaming would remount/tear down
      // the live ChatSurface and make the server's onFinish save throw on the
      // now-soft-deleted row, silently losing the in-flight turn. Block it; the
      // user can delete once the response settles.
      if (chatBusy && id === activeId) {
        return;
      }

      const remaining = sessions.filter((session) => session.id !== id);
      setSessions(remaining);

      try {
        await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      } catch {
        // Ignore; refreshSessions reconciles.
      }

      if (id === activeId) {
        const next = remaining[0];
        if (next) {
          const messages = await fetchSessionMessages(next.id);
          setActive({ id: next.id, messages: messages ?? [] });
        } else {
          setActive({ id: crypto.randomUUID(), messages: [] });
        }
      }

      refreshSessions();
    },
    [sessions, activeId, chatBusy, refreshSessions],
  );

  // Stream finished: refresh now (re-order + new session appears) and again
  // shortly after, to catch the async title write.
  const handleConversationUpdated = useCallback(() => {
    refreshSessions();

    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current);
    }
    refreshTimer.current = setTimeout(refreshSessions, TITLE_REFRESH_DELAY_MS);
  }, [refreshSessions]);

  const handleBusyChange = useCallback((busy: boolean) => setChatBusy(busy), []);
  const handleUsageChange = useCallback((next: ChatUsageSummary) => setUsage(next), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <main
      className="flex h-dvh flex-col overflow-hidden bg-background"
      style={
        {
          "--sidebar-rail": SIDEBAR_RAIL,
          "--sidebar-width": sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_RAIL,
        } as SidebarStyle
      }
    >
      <h1 className="sr-only">AI SDK App</h1>
      <SiteHeader
        actions={<TokenUsageMenu {...usage} />}
        status={
          <SiteHeaderStatus pulse={chatBusy}>{chatBusy ? "Responding" : "Ready"}</SiteHeaderStatus>
        }
      />

      <div className="relative flex min-h-0 flex-1">
        <SessionSidebar
          activeSessionId={activeId ?? ""}
          busy={chatBusy}
          loading={sessionsLoading}
          onClose={closeSidebar}
          onDelete={deleteSession}
          onNew={startNewSession}
          onRename={renameSession}
          onSelect={selectSession}
          onToggle={toggleSidebar}
          open={sidebarOpen}
          sessions={sessions}
        />

        {active ? (
          <ChatSurface
            initialMessages={active.messages}
            key={active.id}
            onBusyChange={handleBusyChange}
            onConversationUpdated={handleConversationUpdated}
            onUsageChange={handleUsageChange}
            sessionId={active.id}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
      </div>
    </main>
  );
}
