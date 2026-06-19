"use client";

import { AlertCircle, Archive, Brain, Plus } from "lucide-react";
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
  createdAt: string;
  updatedAt: string;
};

const MEMORY_KINDS: MemoryKind[] = ["preference", "fact", "correction", "persona"];

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

  useEffect(() => {
    void load();
  }, [load]);

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
      await load();
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
      <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 pb-10 sm:px-8 lg:grid-cols-[minmax(16rem,21rem)_minmax(0,1fr)] lg:px-10">
        <h1 className="sr-only">Memories</h1>

        {error ? (
          <div className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive lg:col-span-2">
            <AlertCircle className="mr-2 inline size-4" aria-hidden="true" />
            {error}
          </div>
        ) : null}

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
                  <span className="block truncate font-medium">{memory.content}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {memory.kind} · {memory.status}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="grid min-w-0 gap-6">
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-lg font-semibold">Create memory</h2>
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
                    {selected.kind} · {selected.source} · confidence {selected.confidence} ·{" "}
                    {formatDate(selected.createdAt)}
                  </p>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {selected.status}
                </span>
              </div>
              {selected.status === "approved" ? (
                <Button
                  className="mt-4"
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
          ) : null}
        </section>
      </main>
    </>
  );
}
