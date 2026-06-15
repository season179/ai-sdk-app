"use client";

import {
  Check,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ChatSessionSummary } from "@/lib/chat/sessions";
import { cn } from "@/lib/utils";

export type SessionSidebarProps = {
  sessions: ChatSessionSummary[];
  activeSessionId: string;
  open: boolean;
  /** A stream is in flight: switching sessions is blocked until it settles. */
  busy?: boolean;
  loading?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  /** Toggle between the full panel and the slim docked rail. */
  onToggle: () => void;
};

type SessionGroup = {
  label: string;
  items: ChatSessionSummary[];
};

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Partition the already-sorted list into Today / Older, preserving order. */
function groupSessions(sessions: ChatSessionSummary[]): SessionGroup[] {
  const now = new Date();
  const today: ChatSessionSummary[] = [];
  const older: ChatSessionSummary[] = [];

  for (const session of sessions) {
    const stamp = new Date(session.lastMessageAt ?? session.createdAt);
    if (isSameDay(stamp, now)) {
      today.push(session);
    } else {
      older.push(session);
    }
  }

  return [
    { label: "Today", items: today },
    { label: "Older", items: older },
  ].filter((group) => group.items.length > 0);
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  open,
  busy = false,
  loading = false,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onClose,
  onToggle,
}: SessionSidebarProps) {
  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  return (
    <>
      {/* Mobile backdrop: tap-to-close while expanded. Never shown once docked (sm+). */}
      {open ? (
        <button
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-[1px] sm:hidden"
          onClick={onClose}
          type="button"
        />
      ) : null}

      {/* In-flow rail that reserves the sidebar's width in the body row, so the
          conversation is pushed (not overlapped) on desktop. The panel itself is
          absolutely positioned within it: on mobile the rail stays slim and the
          expanded panel overlays the conversation instead of shoving it aside. */}
      <div className="relative w-[var(--sidebar-rail)] shrink-0 transition-[width] duration-200 ease-out sm:w-[var(--sidebar-width)]">
        <aside className="absolute inset-y-0 left-0 z-40 flex w-[var(--sidebar-width)] flex-col overflow-hidden border-r border-border bg-background shadow-xl transition-[width] duration-200 ease-out sm:shadow-none">
          {/* The toggle lives where the close (X) control used to: one spot owns
              both expand and collapse, instead of two competing buttons. */}
          <div className="flex items-center gap-2 px-2 py-3 sm:py-4">
            {open ? (
              <span className="pl-1 text-sm font-semibold text-foreground">Chats</span>
            ) : null}
            <Button
              aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
              className={cn("size-9", open ? "ml-auto" : "mx-auto")}
              onClick={onToggle}
              size="icon"
              type="button"
              variant="ghost"
            >
              {open ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
            </Button>
          </div>

          <div className={cn("pb-2", open ? "px-3" : "px-2")}>
            <Button
              aria-label="New chat"
              className={open ? "w-full justify-start gap-2" : "mx-auto size-9"}
              disabled={busy}
              onClick={onNew}
              size={open ? "sm" : "icon"}
              title={open ? undefined : "New chat"}
              type="button"
              variant="outline"
            >
              <Plus className="size-4" />
              {open ? "New chat" : null}
            </Button>
          </div>

          {/* The list only earns its room in the full panel; the rail keeps just
            the two primary affordances. */}
          {open ? (
            <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              {loading && sessions.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">Loading chats...</p>
              ) : sessions.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  No chats yet. Start a conversation to see it here.
                </p>
              ) : (
                groups.map((group) => (
                  <div className="mb-3" key={group.label}>
                    <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </p>
                    <ul className="space-y-0.5">
                      {group.items.map((session) => (
                        <SessionRow
                          busy={busy}
                          isActive={session.id === activeSessionId}
                          key={session.id}
                          onDelete={onDelete}
                          onRename={onRename}
                          onSelect={onSelect}
                          session={session}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </nav>
          ) : null}
        </aside>
      </div>
    </>
  );
}

type SessionRowProps = {
  session: ChatSessionSummary;
  isActive: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
};

function SessionRow({ session, isActive, busy, onSelect, onRename, onDelete }: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const label = session.title?.trim() || "New chat";

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEditing() {
    setDraft(session.title ?? "");
    setEditing(true);
  }

  function commit() {
    const next = draft.trim();
    setEditing(false);

    if (next && next !== (session.title ?? "")) {
      onRename(session.id, next);
    }
  }

  if (editing) {
    return (
      <li>
        <div className="flex items-center gap-1 rounded-md bg-muted px-2 py-1">
          <input
            aria-label="Rename chat"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
            // Match the server's title limit so a too-long title can't round-trip
            // to a 400 that the optimistic update would silently swallow.
            maxLength={200}
            onBlur={commit}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
            ref={inputRef}
            value={draft}
          />
          <button
            aria-label="Save name"
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
            // onMouseDown (not onClick) so it fires before the input's onBlur cancels.
            onMouseDown={(event) => {
              event.preventDefault();
              commit();
            }}
            type="button"
          >
            <Check className="size-3.5" />
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 transition-colors",
        isActive ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
        disabled={busy && !isActive}
        onClick={() => onSelect(session.id)}
        title={label}
        type="button"
      >
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 truncate text-sm",
            isActive ? "text-foreground" : "text-foreground/80",
          )}
        >
          {label}
        </span>
      </button>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          aria-label="Rename chat"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={startEditing}
          type="button"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          aria-label="Delete chat"
          className="rounded p-1 text-muted-foreground hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
          // Can't delete the chat that is actively streaming — it would tear down
          // the live stream and lose the in-flight turn (mirrors the shell guard).
          disabled={busy && isActive}
          onClick={() => {
            if (window.confirm(`Delete "${label}"? This cannot be undone.`)) {
              onDelete(session.id);
            }
          }}
          type="button"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </li>
  );
}
