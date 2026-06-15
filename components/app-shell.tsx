"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  type ActiveSession,
  type ChatMessage,
  ChatShellProvider,
  type ChatShellValue,
} from "@/components/chat/chat-shell-context";
import type { ChatUsageSummary } from "@/components/chat/token-usage-menu";
import type { ChatSessionSummary } from "@/lib/chat/sessions";
import { isUuid } from "@/lib/utils";

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

/**
 * The app frame: a persistent full-height sidebar plus a content region for the
 * routed page. It lives in the root layout, so the sidebar (nav + chat session
 * list) is constant across /chat, /tasks, and /skills, and the chat state it
 * owns survives navigation between them. The active page reads this state via
 * useChatShell().
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

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

      // ?c= only carries a chat id while we're on the chat route; elsewhere the
      // query string belongs to that page, so we resolve most-recent instead.
      const onChat = window.location.pathname === "/";
      const requested = onChat ? new URLSearchParams(window.location.search).get("c") : null;
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

  // Keep ?c= in sync (chat route only) without a navigation, so reloads and
  // bookmarks resume. Guarded so it never clobbers /tasks or /skills URLs.
  useEffect(() => {
    if (activeId && pathname === "/" && typeof window !== "undefined") {
      window.history.replaceState(null, "", `/?c=${activeId}`);
    }
  }, [activeId, pathname]);

  useEffect(
    () => () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
      }
    },
    [],
  );

  // Selecting or starting a chat from another page lands on the chat route; the
  // shell persists across the push, so the active session is already resolved
  // by the time it renders.
  const goToChat = useCallback(() => {
    if (pathname !== "/") {
      router.push("/");
    }
  }, [pathname, router]);

  const closeSidebarOnMobile = useCallback(() => {
    if (isMobileViewport()) {
      setSidebarOpen(false);
    }
  }, []);

  const selectSession = useCallback(
    async (id: string) => {
      goToChat();
      closeSidebarOnMobile();

      // Never swap the transcript out from under an in-flight stream; if it's
      // already active, the navigation above is all that's needed.
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
    [chatBusy, activeId, goToChat, closeSidebarOnMobile, refreshSessions],
  );

  const startNewSession = useCallback(() => {
    if (chatBusy) {
      return;
    }

    goToChat();
    closeSidebarOnMobile();
    // Not persisted until the first reply finishes, so it isn't in the list yet.
    setActive({ id: crypto.randomUUID(), messages: [] });
  }, [chatBusy, goToChat, closeSidebarOnMobile]);

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
  const reportConversationUpdated = useCallback(() => {
    refreshSessions();

    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current);
    }
    refreshTimer.current = setTimeout(refreshSessions, TITLE_REFRESH_DELAY_MS);
  }, [refreshSessions]);

  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  const value = useMemo<ChatShellValue>(
    () => ({
      sessions,
      sessionsLoading,
      active,
      activeId,
      chatBusy,
      usage,
      sidebarOpen,
      toggleSidebar,
      closeSidebar,
      selectSession,
      startNewSession,
      renameSession,
      deleteSession,
      setBusy: setChatBusy,
      setUsage,
      reportConversationUpdated,
    }),
    [
      sessions,
      sessionsLoading,
      active,
      activeId,
      chatBusy,
      usage,
      sidebarOpen,
      toggleSidebar,
      closeSidebar,
      selectSession,
      startNewSession,
      renameSession,
      deleteSession,
      reportConversationUpdated,
    ],
  );

  return (
    <ChatShellProvider value={value}>
      <div
        className="flex h-dvh overflow-hidden bg-background"
        style={
          {
            "--sidebar-rail": SIDEBAR_RAIL,
            "--sidebar-width": sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_RAIL,
          } as SidebarStyle
        }
      >
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </ChatShellProvider>
  );
}
