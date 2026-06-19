"use client";

import { AlertCircle, Check, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import type { ReviewProposalKind, ReviewProposalPayload, ReviewProposalStatus } from "@/db/schema";
import { cn } from "@/lib/utils";

type ReviewProposal = {
  id: string;
  sessionId: string | null;
  triggerMessageId: string | null;
  kind: ReviewProposalKind;
  payload: ReviewProposalPayload;
  rationale: string;
  status: ReviewProposalStatus;
  reviewerModel: string | null;
  appliedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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

export default function ProposalsPage() {
  const [proposals, setProposals] = useState<ReviewProposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => proposals.find((proposal) => proposal.id === selectedId) ?? proposals[0] ?? null,
    [proposals, selectedId],
  );
  const pendingCount = proposals.filter((proposal) => proposal.status === "pending").length;

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/proposals");
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as { proposals?: ReviewProposal[] };
      const next = Array.isArray(data.proposals) ? data.proposals : [];
      setProposals(next);
      setSelectedId((current) =>
        current && next.some((item) => item.id === current) ? current : null,
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load proposals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch(`/api/proposals/${id}/${action}`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      await load();
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : `Could not ${action} proposal.`,
      );
    } finally {
      setBusyId(null);
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
          <SiteHeaderStatus pulse={pendingCount > 0}>
            {loading
              ? "Loading proposals"
              : `${pendingCount} pending proposal${pendingCount === 1 ? "" : "s"}`}
          </SiteHeaderStatus>
        }
      />
      <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 pb-10 sm:px-8 lg:grid-cols-[minmax(16rem,21rem)_minmax(0,1fr)] lg:px-10">
        <h1 className="sr-only">Review proposals</h1>

        {error ? (
          <div className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive lg:col-span-2">
            <AlertCircle className="mr-2 inline size-4" aria-hidden="true" />
            {error}
          </div>
        ) : null}

        <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <Sparkles className="size-3.5" aria-hidden="true" />
            Proposals
          </div>
          <div className="space-y-1">
            {loading ? (
              <div className="h-24 animate-pulse rounded-lg bg-muted" />
            ) : proposals.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                No proposals yet.
              </div>
            ) : (
              proposals.map((proposal) => (
                <button
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                    selected?.id === proposal.id && "bg-muted text-foreground",
                  )}
                  key={proposal.id}
                  onClick={() => setSelectedId(proposal.id)}
                  type="button"
                >
                  <span className="block truncate font-medium">{proposal.kind}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {proposal.status} · {formatDate(proposal.createdAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="min-w-0">
          {selected ? (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">Proposal</p>
                  <h2 className="truncate text-lg font-semibold">{selected.kind}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selected.reviewerModel ?? "unknown model"} · {formatDate(selected.createdAt)}
                  </p>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {selected.status}
                </span>
              </div>

              <div className="mt-5 grid gap-4">
                <section>
                  <h3 className="text-sm font-semibold">Rationale</h3>
                  <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground">
                    {selected.rationale}
                  </p>
                </section>

                <section>
                  <h3 className="text-sm font-semibold">Payload</h3>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                    {JSON.stringify(selected.payload, null, 2)}
                  </pre>
                </section>

                {selected.error ? (
                  <section className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
                    <AlertCircle className="mr-2 inline size-4" aria-hidden="true" />
                    {selected.error}
                  </section>
                ) : null}

                {selected.status === "pending" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busyId === selected.id}
                      onClick={() => void act(selected.id, "approve")}
                      type="button"
                    >
                      <Check className="size-4" aria-hidden="true" />
                      Approve
                    </Button>
                    <Button
                      disabled={busyId === selected.id}
                      onClick={() => void act(selected.id, "reject")}
                      type="button"
                      variant="outline"
                    >
                      <X className="size-4" aria-hidden="true" />
                      Reject
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
              Select a proposal to review.
            </div>
          )}
        </section>
      </main>
    </>
  );
}
