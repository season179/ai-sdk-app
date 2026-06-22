"use client";

import { AlertCircle, Brain, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RunSummary = {
  id: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  observationsScanned: number;
  candidatesEvaluated: number;
  candidatesPassed: number;
  proposalsCreated: number;
  error: string | null;
};

type CandidateSummary = {
  id: string;
  claimKey: string;
  snippet: string;
  scoreBps: number;
  passed: boolean;
  proposalId: string | null;
  gateResults: Record<
    string,
    {
      passed: boolean;
      actual?: number;
      threshold?: number;
      actualBps?: number;
      thresholdBps?: number;
    }
  >;
  createdAt: string;
};

type StatusPayload = {
  env: { enabled: boolean; dryRun: boolean; autoApply: boolean };
  settings: {
    enabled: boolean;
    autoApplyEnabled: boolean;
    dryRun: boolean;
    minScoreBps: number;
    minRecallCount: number;
    minUniqueQueries: number;
    maxAgeDays: number;
  };
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

async function readApiError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "Request failed.";
}

export default function ConsolidationPage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/consolidation/status");
      if (!res.ok) throw new Error(await readApiError(res));
      setStatus((await res.json()) as StatusPayload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load status.");
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/consolidation/runs");
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { runs?: RunSummary[] };
      const next = Array.isArray(data.runs) ? data.runs : [];
      setRuns(next);
      setSelectedRunId((cur) => cur ?? next[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load runs.");
    }
  }, []);

  useEffect(() => {
    Promise.all([loadStatus(), loadRuns()]).finally(() => setLoading(false));
  }, [loadStatus, loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/consolidation/candidates?runId=${encodeURIComponent(selectedRunId)}`)
      .then((r) => r.json())
      .then((data: { candidates?: CandidateSummary[] }) => {
        if (!cancelled) setCandidates(Array.isArray(data.candidates) ? data.candidates : []);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/consolidation/run", { method: "POST" });
      if (!res.ok) throw new Error(await readApiError(res));
      await loadRuns();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Could not enqueue run.");
    } finally {
      setRunning(false);
    }
  }

  const lastRun = runs[0] ?? null;
  const enabled = status?.settings.enabled ?? false;

  return (
    <>
      <SiteHeader
        actions={
          <Button
            disabled={running || !enabled}
            onClick={() => void runNow()}
            size="sm"
            type="button"
          >
            <Play className="size-4" aria-hidden="true" />
            Run now
          </Button>
        }
        status={
          <SiteHeaderStatus pulse={enabled}>
            {loading
              ? "Loading"
              : enabled
                ? status?.settings.dryRun
                  ? "Dry-run on"
                  : "Enabled"
                : "Disabled"}
          </SiteHeaderStatus>
        }
      />
      <main className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-8 lg:px-10">
        <h1 className="sr-only">Consolidation</h1>

        {error ? (
          <div className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
            <AlertCircle className="mr-2 inline size-4" aria-hidden="true" />
            {error}
          </div>
        ) : null}

        {!enabled ? (
          <div className="mb-6 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            <Brain className="mr-2 inline size-4" aria-hidden="true" />
            Memory consolidation is disabled. Set <code>MEMORY_CONSOLIDATION_ENABLED=true</code> to
            enable sweeps.
          </div>
        ) : null}

        <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Last run" value={lastRun ? formatDate(lastRun.startedAt) : "Never"} />
          <StatCard
            label="Last candidates"
            value={lastRun ? String(lastRun.candidatesEvaluated) : "—"}
          />
          <StatCard label="Last passed" value={lastRun ? String(lastRun.candidatesPassed) : "—"} />
          <StatCard
            label="Last proposals"
            value={lastRun ? String(lastRun.proposalsCreated) : "—"}
          />
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold">Run feed</h2>
          {runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No runs yet.
            </div>
          ) : (
            <ul className="space-y-1">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    className={cn(
                      "w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                      selectedRunId === run.id && "bg-muted text-foreground",
                    )}
                    onClick={() => setSelectedRunId(run.id)}
                    type="button"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "inline-block size-2 rounded-full",
                          run.status === "completed"
                            ? "bg-emerald-500"
                            : run.status === "failed"
                              ? "bg-destructive"
                              : "bg-amber-500",
                        )}
                        aria-hidden="true"
                      />
                      <span className="font-medium">{run.trigger}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(run.startedAt)} · {run.candidatesEvaluated} candidates ·{" "}
                        {run.proposalsCreated} proposals
                      </span>
                    </span>
                    {run.error ? (
                      <span className="mt-1 block text-xs text-destructive">{run.error}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Candidates</h2>
          {candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {selectedRunId ? "No candidates for this run." : "Select a run."}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Snippet</th>
                    <th className="px-3 py-2 text-right font-medium">Score</th>
                    <th className="px-3 py-2 text-left font-medium">Gates</th>
                    <th className="px-3 py-2 text-left font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id} className="border-t border-border">
                      <td className="max-w-[28ch] truncate px-3 py-2">{c.snippet}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(c.scoreBps / 10000).toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {Object.entries(c.gateResults).filter(([, g]) => g.passed).length}/
                        {Object.keys(c.gateResults).length}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            c.passed
                              ? "bg-emerald-500/10 text-emerald-600"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {c.passed ? "Passed" : "Below gates"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}
