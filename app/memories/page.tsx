"use client";

import { AlertCircle, Archive, Brain, Clock, Lock, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import type { MemoryKind, MemorySource, MemoryStatus } from "@/db/schema";
import { cn } from "@/lib/utils";

type Memory = {
  id: string;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  confidence: number;
  status: MemoryStatus;
  isProtected: boolean;
  createdAt: string;
  updatedAt: string;
};

type MemoryEvent = {
  id: string;
  eventType: string;
  origin: string;
  summary: string;
  memoryId: string | null;
  proposalId: string | null;
  runId: string | null;
  detail: { reason?: string; admissionMetadata?: { scoreBps?: number } } | null;
  createdAt: string;
};

const MEMORY_KINDS: MemoryKind[] = ["preference", "fact", "correction", "persona"];

const SOURCE_COLORS: Record<MemorySource, string> = {
  user: "bg-emerald-500/10 text-emerald-600",
  review: "bg-blue-500/10 text-blue-600",
  curated: "bg-purple-500/10 text-purple-600",
  consolidated: "bg-amber-500/10 text-amber-600",
};

async function readApiError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "Request failed.";
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function MemoriesPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [tab, setTab] = useState<"memories" | "timeline">("memories");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [content, setContent] = useState("");
  const [confidence, setConfidence] = useState(100);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => memories.find((memory) => memory.id === selectedId) ?? memories[0] ?? null,
    [memories, selectedId],
  );
  const approvedCount = memories.filter((memory) => memory.status === "approved").length;

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/memories");
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as { memories?: Memory[] };
      const next = Array.isArray(data.memories) ? data.memories : [];
      setMemories(next);
      setSelectedId((current) =>
        current && next.some((item) => item.id === current) ? current : null,
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load memories.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const res = await fetch("/api/memory-events");
      if (!res.ok) return;
      const data = (await res.json()) as { events?: MemoryEvent[] };
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch {
      // Fail-soft: timeline is observability, not a correctness gate.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadEvents();
  }, [load, loadEvents]);

  async function toggleProtect(memory: Memory) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/memories/${memory.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isProtected: !memory.isProtected }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      await Promise.all([load(), loadEvents()]);
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Could not toggle pin.");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, content, confidence, source: "user" }),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      setContent("");
      setConfidence(100);
      await Promise.all([load(), loadEvents()]);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create memory.");
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/memories/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      await load();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "Could not archive memory.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SiteHeader
        actions={
          <Button onClick={() => void load()} size="sm" type="button" variant="outline">
            Refresh
          </Button>
        }
        status={
          <SiteHeaderStatus>
            {loading
              ? "Loading memories"
              : `${approvedCount} approved ${approvedCount === 1 ? "memory" : "memories"}`}
          </SiteHeaderStatus>
        }
      />
      <main className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-8 lg:px-10">
        <h1 className="sr-only">Memories</h1>

        <div
          className="mb-4 inline-flex rounded-lg border border-border p-0.5 text-sm"
          role="tablist"
        >
          <button
            aria-selected={tab === "memories"}
            className={cn(
              "rounded-md px-3 py-1.5 transition-colors",
              tab === "memories" ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
            onClick={() => setTab("memories")}
            role="tab"
            type="button"
          >
            Memories
          </button>
          <button
            aria-selected={tab === "timeline"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors",
              tab === "timeline" ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
            onClick={() => setTab("timeline")}
            role="tab"
            type="button"
          >
            <Clock className="size-3.5" aria-hidden="true" />
            Timeline
          </button>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
            <AlertCircle className="mr-2 inline size-4" aria-hidden="true" />
            {error}
          </div>
        ) : null}

        {tab === "timeline" ? (
          <TimelineView events={events} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(16rem,21rem)_minmax(0,1fr)]">
            <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <Brain className="size-3.5" aria-hidden="true" />
                Memories
              </div>
              <div className="space-y-1">
                {loading ? (
                  <div className="h-24 animate-pulse rounded-lg bg-muted" />
                ) : memories.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                    No memories yet.
                  </div>
                ) : (
                  memories.map((memory) => (
                    <button
                      className={cn(
                        "w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                        selected?.id === memory.id && "bg-muted text-foreground",
                      )}
                      key={memory.id}
                      onClick={() => setSelectedId(memory.id)}
                      type="button"
                    >
                      <span className="flex items-center gap-1.5 truncate font-medium">
                        {memory.isProtected ? (
                          <Lock className="size-3 shrink-0 text-amber-600" aria-hidden="true" />
                        ) : null}
                        <span className="truncate">{memory.content}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{memory.kind}</span>
                        <span
                          className={cn(
                            "rounded px-1 py-0.5 text-[10px] font-medium",
                            SOURCE_COLORS[memory.source],
                          )}
                        >
                          {memory.source}
                        </span>
                        <span>· {memory.status}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <section className="grid min-w-0 gap-6">
              <div className="rounded-lg border border-border bg-card p-4">
                <h2 className="text-lg font-semibold">Create memory</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  The client cannot set source — every manual memory is <code>source: user</code>.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,8rem)]">
                  <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                    Kind
                    <select
                      className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                      onChange={(event) => setKind(event.target.value as MemoryKind)}
                      value={kind}
                    >
                      {MEMORY_KINDS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                    Content
                    <textarea
                      className="min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                      onChange={(event) => setContent(event.target.value)}
                      value={content}
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                    Confidence
                    <input
                      className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                      max={100}
                      min={0}
                      onChange={(event) => setConfidence(Number(event.target.value))}
                      type="number"
                      value={confidence}
                    />
                  </label>
                </div>
                <Button
                  className="mt-4"
                  disabled={busy || content.trim().length === 0}
                  onClick={() => void create()}
                  type="button"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Create memory
                </Button>
              </div>

              {selected ? (
                <div className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted-foreground">Selected memory</p>
                      <h2 className="max-w-[72ch] text-lg font-semibold">{selected.content}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selected.kind} ·{" "}
                        <span className={cn("rounded px-1", SOURCE_COLORS[selected.source])}>
                          {selected.source}
                        </span>{" "}
                        · confidence {selected.confidence} · {formatDate(selected.createdAt)}
                      </p>
                      {selected.isProtected ? (
                        <p className="mt-1 inline-flex items-center gap-1 text-xs text-amber-600">
                          <Lock className="size-3" aria-hidden="true" />
                          Protected — excluded from consolidation/curator archive + edit.
                        </p>
                      ) : null}
                    </div>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {selected.status}
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => void toggleProtect(selected)}
                      type="button"
                      variant="outline"
                    >
                      <Lock className="size-4" aria-hidden="true" />
                      {selected.isProtected ? "Unprotect" : "Protect"}
                    </Button>
                    {selected.status === "approved" && !selected.isProtected ? (
                      <Button
                        disabled={busy}
                        onClick={() => void archive(selected.id)}
                        type="button"
                        variant="outline"
                      >
                        <Archive className="size-4" aria-hidden="true" />
                        Archive
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </main>
    </>
  );
}

function dayKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function TimelineView({ events }: { events: MemoryEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        No memory events yet. The timeline shows how memories evolve — creations, edits, proposals,
        and consolidation runs. (Retrievals via memory_search are never logged here.)
      </div>
    );
  }

  // Group by day, newest first.
  const groups = new Map<string, MemoryEvent[]>();
  for (const e of events) {
    const key = dayKey(e.createdAt);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const days = Array.from(groups.keys()).sort().reverse();

  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {day}
          </h2>
          <ul className="space-y-1">
            {groups.get(day)?.map((e) => (
              <li key={e.id} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {e.eventType}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {e.origin}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <p className="mt-1 text-sm text-foreground">{e.summary}</p>
                {e.detail?.admissionMetadata?.scoreBps != null ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Score {(e.detail.admissionMetadata.scoreBps / 10000).toFixed(4)}
                  </p>
                ) : null}
                {e.detail?.reason ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">Reason: {e.detail.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
