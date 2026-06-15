"use client";

import type { UIMessage } from "ai";
import { createContext, useContext } from "react";

import type { ChatUsageSummary } from "@/components/chat/token-usage-menu";
import type { ChatSessionSummary } from "@/lib/chat/sessions";
import type { ChatMessageMetadata } from "@/lib/token-usage";

export type ChatMessage = UIMessage<ChatMessageMetadata>;
export type ActiveSession = { id: string; messages: ChatMessage[] };

/**
 * App-wide chat state. It lives in <AppShell> (the root layout) so the
 * persistent sidebar and the chat route share one source of truth: the sidebar
 * can switch sessions from any page, and the chat page renders whatever session
 * the shell has resolved.
 */
export type ChatShellValue = {
  sessions: ChatSessionSummary[];
  sessionsLoading: boolean;
  active: ActiveSession | null;
  activeId: string | null;
  /** A stream is in flight: session switches and deletes are guarded. */
  chatBusy: boolean;
  usage: ChatUsageSummary;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  /** Open a session (navigating to the chat route first when elsewhere). */
  selectSession: (id: string) => void;
  startNewSession: () => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  // Reporters the live ChatSurface calls back into.
  setBusy: (busy: boolean) => void;
  setUsage: (usage: ChatUsageSummary) => void;
  reportConversationUpdated: () => void;
};

const ChatShellContext = createContext<ChatShellValue | null>(null);

export const ChatShellProvider = ChatShellContext.Provider;

export function useChatShell(): ChatShellValue {
  const value = useContext(ChatShellContext);

  if (!value) {
    throw new Error("useChatShell must be used within <AppShell>");
  }

  return value;
}
