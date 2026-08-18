"use client";

import { AlertCircle, AlertTriangle, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Entry = {
  key: string;
  updatedAt: string;
  summary: string;
  details: Array<{ timestamp: string; text: string }>;
  estimatedTokenCount: number;
  needsReview: boolean;
  safetyIssues: string[];
};
type DocumentDto = {
  version: number;
  indexBody: string;
  indexTokenCount: number;
  detailsTokenCount: number;
  entryCount: number;
  degraded: boolean;
  entries: Entry[];
};
type Draft = { summary: string; details: string[] };
type ConflictRecovery = {
  drafts: Record<string, Draft>;
  adding: Draft;
  deletedDrafts: Array<{ key: string; draft: Draft }>;
};
type Problem = { error?: string; conflict?: boolean; issues?: string[] };

const draftFrom = (entry: Entry): Draft => ({
  summary: entry.summary,
  details: entry.details.map((item) => item.text),
});
const draftsFrom = (document: DocumentDto) =>
  Object.fromEntries(document.entries.map((entry) => [entry.key, draftFrom(entry)]));
function differs(entry: Entry, draft: Draft) {
  return (
    entry.summary !== draft.summary ||
    entry.details.length !== draft.details.length ||
    entry.details.some((item, index) => item.text !== draft.details[index])
  );
}
function isEmptyDraft(draft: Draft) {
  return draft.summary.length === 0 && draft.details.every((detail) => detail.length === 0);
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
async function problem(response: Response): Promise<Problem> {
  const body = (await response.json().catch(() => null)) as Problem | null;
  return {
    error: body?.error ?? "Request failed.",
    conflict: response.status === 409 && body?.conflict === true,
    issues: body?.issues,
  };
}

export function MemoryDocumentEditor() {
  const [document, setDocument] = useState<DocumentDto | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adding, setAdding] = useState<Draft>({ summary: "", details: [""] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [deletedDrafts, setDeletedDrafts] = useState<Array<{ key: string; draft: Draft }>>([]);

  const load = useCallback(async (preserved?: ConflictRecovery) => {
    setLoading(true);
    setError(null);
    setConflict(false);
    setIssues([]);
    try {
      const response = await fetch("/api/memory-document", { cache: "no-store" });
      if (!response.ok) throw new Error((await problem(response)).error);
      const data = (await response.json()) as { document?: DocumentDto };
      if (!data.document) throw new Error("Memory document response was incomplete.");
      const nextDrafts = draftsFrom(data.document);
      if (preserved) {
        let nextAdding = preserved.adding;
        const nextDeletedDrafts = [...preserved.deletedDrafts];
        for (const [key, draft] of Object.entries(preserved.drafts)) {
          if (data.document.entries.some((entry) => entry.key === key)) {
            nextDrafts[key] = draft;
          } else if (isEmptyDraft(nextAdding)) {
            nextAdding = draft;
          } else {
            nextDeletedDrafts.push({ key, draft });
          }
        }
        setAdding(nextAdding);
        setDeletedDrafts(nextDeletedDrafts);
      }
      setDocument(data.document);
      setDrafts(nextDrafts);
    } catch (cause) {
      setConflict(Boolean(preserved));
      setError(cause instanceof Error ? cause.message : "Could not load the memory document.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function apply(next: DocumentDto, resetKey?: string) {
    const previous = document;
    setDocument(next);
    setDrafts((current) => {
      const merged = draftsFrom(next);
      if (!previous) return merged;
      for (const entry of next.entries) {
        const prior = previous.entries.find((item) => item.key === entry.key);
        const draft = current[entry.key];
        if (prior && draft && entry.key !== resetKey && differs(prior, draft))
          merged[entry.key] = draft;
      }
      return merged;
    });
    setConflict(false);
    setIssues([]);
  }
  function showProblem(value: Problem, message: string) {
    setConflict(Boolean(value.conflict));
    setIssues(value.issues ?? []);
    setError(value.conflict ? message : (value.error ?? "Request failed."));
  }

  async function create(draft = adding, deletedKey?: string) {
    if (!document) return;
    setBusy("new");
    setError(null);
    try {
      const response = await fetch("/api/memory-document/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: document.version, ...draft }),
      });
      if (!response.ok)
        return showProblem(
          await problem(response),
          "Memory changed on the server. Reload before adding. Your draft is preserved.",
        );
      const data = (await response.json()) as { document?: DocumentDto };
      if (!data.document) throw new Error("Created memory response was incomplete.");
      apply(data.document);
      if (deletedKey) {
        setDeletedDrafts((current) => current.filter((item) => item.key !== deletedKey));
      } else {
        setAdding({ summary: "", details: [""] });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the memory.");
    } finally {
      setBusy(null);
    }
  }
  async function save(key: string) {
    if (!document || !drafts[key]) return;
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(`/api/memory-document/entries/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: document.version, ...drafts[key] }),
      });
      if (!response.ok)
        return showProblem(
          await problem(response),
          "Memory changed on the server. Reload before saving. Your drafts are preserved.",
        );
      const data = (await response.json()) as { document?: DocumentDto };
      if (!data.document) throw new Error("Saved memory response was incomplete.");
      apply(data.document, key);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the memory.");
    } finally {
      setBusy(null);
    }
  }
  async function remove(key: string) {
    if (!document || !window.confirm("Delete this memory entry? This cannot be undone.")) return;
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(
        `/api/memory-document/entries/${encodeURIComponent(key)}?expectedVersion=${document.version}`,
        { method: "DELETE" },
      );
      if (!response.ok)
        return showProblem(
          await problem(response),
          "Memory changed on the server. Reload before deleting. Your drafts are preserved.",
        );
      const data = (await response.json()) as { document?: DocumentDto };
      if (!data.document) throw new Error("Deleted memory response was incomplete.");
      apply(data.document);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the memory.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <SiteHeader
        actions={
          <Button
            disabled={loading || busy !== null}
            onClick={() => void load()}
            size="sm"
            variant="outline"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        }
        status={
          <SiteHeaderStatus pulse={loading || busy !== null}>
            {loading
              ? "Loading memory"
              : document?.degraded
                ? "Some entries need review"
                : document
                  ? `Memory document v${document.version}`
                  : "Memory unavailable"}
          </SiteHeaderStatus>
        }
      />
      <main className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-8 lg:px-10">
        <h1 className="sr-only">Memory document</h1>
        {error ? (
          <div
            className="mb-6 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
            role="alert"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                <AlertCircle className="mr-2 inline size-4" />
                {error}
              </span>
              {conflict ? (
                <Button
                  onClick={() =>
                    void load({
                      drafts: Object.fromEntries(
                        (document?.entries ?? []).flatMap((entry) => {
                          const draft = drafts[entry.key];
                          return draft && differs(entry, draft) ? [[entry.key, draft]] : [];
                        }),
                      ),
                      adding,
                      deletedDrafts,
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  Reload latest
                </Button>
              ) : null}
            </div>
            {issues.length ? (
              <ul className="mt-2 list-disc pl-6 text-xs">
                {issues.map((item) => (
                  <li key={item}>{item.replaceAll("_", " ")}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {loading && !document ? (
          <div className="grid gap-6 lg:grid-cols-[1fr_19rem]">
            <div className="h-80 animate-pulse rounded-lg bg-muted" />
            <div className="h-52 animate-pulse rounded-lg bg-muted" />
          </div>
        ) : document ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
            <div className="min-w-0 space-y-8">
              <section>
                <h2 className="text-lg font-semibold">Memory index</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  This exact compact index is available in chat. Details are fetched only when
                  needed.
                </p>
                {document.indexBody ? (
                  <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg border bg-card p-4 font-mono text-xs leading-5">
                    {document.indexBody}
                  </pre>
                ) : (
                  <div className="mt-4 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                    The memory index is empty.
                  </div>
                )}
              </section>
              <section>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Entries</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Summaries form the index; timestamped details remain on demand.
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {document.entryCount} / 24 entries
                  </span>
                </div>
                {document.entries.length ? (
                  <ol className="mt-4 space-y-4">
                    {document.entries.map((entry) => {
                      const draft = drafts[entry.key] ?? draftFrom(entry);
                      return (
                        <li key={entry.key}>
                          <article
                            className={cn(
                              "rounded-lg border bg-card p-4",
                              entry.needsReview && "border-amber-500/40",
                            )}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <code className="break-all text-[11px] text-muted-foreground">
                                    {entry.key}
                                  </code>
                                  {entry.needsReview ? (
                                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
                                      <AlertTriangle className="mr-1 inline size-3" />
                                      Needs review
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  Updated {formatDate(entry.updatedAt)} ·{" "}
                                  {entry.estimatedTokenCount} estimated tokens
                                </p>
                                {entry.needsReview ? (
                                  <p className="mt-1 text-[11px] text-amber-700">
                                    {entry.safetyIssues
                                      .map((item) => item.replaceAll("_", " "))
                                      .join(", ")}
                                  </p>
                                ) : null}
                              </div>
                              {differs(entry, draft) ? (
                                <span className="text-xs text-muted-foreground">Unsaved draft</span>
                              ) : null}
                            </div>
                            <Fields
                              draft={draft}
                              disabled={busy !== null}
                              timestamps={entry.details.map((item) => item.timestamp)}
                              onChange={(next) =>
                                setDrafts((current) => ({ ...current, [entry.key]: next }))
                              }
                            />
                            <div className="mt-4 flex gap-2">
                              <Button
                                disabled={busy !== null || !differs(entry, draft)}
                                onClick={() => void save(entry.key)}
                                size="sm"
                              >
                                <Save className="size-3.5" />
                                Save
                              </Button>
                              <Button
                                disabled={busy !== null}
                                onClick={() => void remove(entry.key)}
                                size="sm"
                                variant="outline"
                              >
                                <Trash2 className="size-3.5 text-destructive" />
                                Delete
                              </Button>
                            </div>
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <div className="mt-4 rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
                    No durable memory entries yet.
                  </div>
                )}
              </section>
              {deletedDrafts.length ? (
                <section>
                  <h2 className="text-lg font-semibold">Recovered drafts</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    These edited entries were deleted on the server. Add them again or discard them.
                  </p>
                  <div className="mt-4 space-y-4">
                    {deletedDrafts.map(({ key, draft }) => (
                      <article
                        className="rounded-lg border border-amber-500/40 bg-card p-4"
                        key={key}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <code className="break-all text-[11px] text-muted-foreground">{key}</code>
                          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
                            Deleted on server
                          </span>
                        </div>
                        <Fields
                          draft={draft}
                          disabled={busy !== null}
                          onChange={(next) =>
                            setDeletedDrafts((current) =>
                              current.map((item) =>
                                item.key === key ? { ...item, draft: next } : item,
                              ),
                            )
                          }
                        />
                        <div className="mt-4 flex gap-2">
                          <Button
                            disabled={busy !== null}
                            onClick={() => void create(draft, key)}
                            size="sm"
                          >
                            <Plus className="size-3.5" />
                            {busy === "new" ? "Adding…" : "Add as new entry"}
                          </Button>
                          <Button
                            disabled={busy !== null}
                            onClick={() =>
                              setDeletedDrafts((current) =>
                                current.filter((item) => item.key !== key),
                              )
                            }
                            size="sm"
                            variant="outline"
                          >
                            Discard draft
                          </Button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="rounded-lg border bg-card p-4">
                <h2 className="text-lg font-semibold">Add entry</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Keys and timestamps are created by the server.
                </p>
                <Fields draft={adding} disabled={busy !== null} onChange={setAdding} />
                <Button className="mt-4" disabled={busy !== null} onClick={() => void create()}>
                  <Plus className="size-4" />
                  {busy === "new" ? "Adding…" : "Add entry"}
                </Button>
              </section>
            </div>
            <aside className="min-w-0 lg:sticky lg:top-20">
              <div className="rounded-lg border bg-card p-4">
                <div className="flex justify-between gap-3">
                  <h2 className="text-sm font-semibold">Document state</h2>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                    v{document.version}
                  </span>
                </div>
                <dl className="mt-5 grid gap-4 text-xs">
                  <Usage label="Index estimate" value={document.indexTokenCount} limit={1000} />
                  <Usage label="Details estimate" value={document.detailsTokenCount} limit={4000} />
                  <div>
                    <dt className="text-muted-foreground">Entries</dt>
                    <dd>{document.entryCount} / 24</dd>
                  </div>
                </dl>
                {document.degraded ? (
                  <p className="mt-5 rounded-md border border-amber-500/30 p-3 text-xs text-amber-700">
                    <AlertTriangle className="mr-1 inline size-3.5" />
                    Needs-review entries are never sent to a model. Repair or delete them here.
                  </p>
                ) : null}
              </div>
            </aside>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
            Memory data is unavailable. Use Refresh to try again.
          </div>
        )}
      </main>
    </>
  );
}

function Fields({
  draft,
  disabled,
  timestamps,
  onChange,
}: {
  draft: Draft;
  disabled: boolean;
  timestamps?: string[];
  onChange: (next: Draft) => void;
}) {
  return (
    <div className="mt-4 grid gap-4">
      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        Summary
        <input
          className="rounded-md border bg-background px-3 py-2 text-sm text-foreground"
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, summary: event.currentTarget.value })}
          value={draft.summary}
        />
      </label>
      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Details</span>
          <Button
            disabled={disabled || draft.details.length >= 16}
            onClick={() => onChange({ ...draft, details: [...draft.details, ""] })}
            size="sm"
            variant="ghost"
          >
            <Plus className="size-3.5" />
            Add detail
          </Button>
        </div>
        <ol className="mt-2 space-y-2">
          {draft.details.map((text, index) => (
            // Detail lines have no durable identity beyond their ordered position.
            // biome-ignore lint/suspicious/noArrayIndexKey: controlled inputs safely follow that order.
            <li className="flex items-start gap-2" key={`${index}-${timestamps?.[index] ?? "new"}`}>
              <label className="min-w-0 flex-1">
                <span className="sr-only">Detail {index + 1}</span>
                <textarea
                  className="min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
                  disabled={disabled}
                  onChange={(event) => {
                    const details = [...draft.details];
                    details[index] = event.currentTarget.value;
                    onChange({ ...draft, details });
                  }}
                  value={text}
                />
                {timestamps?.[index] ? (
                  <span className="block text-[10px] text-muted-foreground">
                    {formatDate(timestamps[index])}
                  </span>
                ) : null}
              </label>
              <Button
                aria-label={`Remove detail ${index + 1}`}
                disabled={disabled || draft.details.length <= 1}
                onClick={() =>
                  onChange({ ...draft, details: draft.details.filter((_, item) => item !== index) })
                }
                size="icon"
                variant="ghost"
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
function Usage({ label, value, limit }: { label: string; value: number; limit: number }) {
  return (
    <div>
      <dt className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span>
          {value.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </dt>
      <dd className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full bg-primary"
          style={{ width: `${Math.min(100, (value / limit) * 100)}%` }}
        />
      </dd>
    </div>
  );
}
