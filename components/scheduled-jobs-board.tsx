"use client";

import { AlertCircle, CalendarClock, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { extractStatusUpdate, formatTimestamp } from "@/lib/scheduler/display";
import type {
  ScheduledJobRun,
  ScheduledJobsOverview,
  UpcomingScheduledJob,
} from "@/lib/scheduler/overview";
import { cn } from "@/lib/utils";

const REFRESH_INTERVAL_MS = 10_000;

type BoardState = {
  overview: ScheduledJobsOverview | null;
  loading: boolean;
  error: string | null;
};

export function ScheduledJobsBoard() {
  const [state, setState] = useState<BoardState>({ overview: null, loading: true, error: null });

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));

    try {
      const response = await fetch("/api/scheduled-tasks/overview");
      const body: { overview?: ScheduledJobsOverview; error?: string } = await response.json();

      if (!response.ok || !body.overview) {
        throw new Error(body.error ?? "Failed to load scheduled jobs.");
      }

      setState({ overview: body.overview, loading: false, error: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load scheduled jobs.",
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [refresh]);

  const { overview } = state;
  const isEmpty =
    overview !== null &&
    overview.running.length === 0 &&
    overview.upcoming.length === 0 &&
    overview.past.length === 0;

  return (
    <main className="min-h-dvh bg-background">
      <h1 className="sr-only">Scheduled tasks</h1>
      <SiteHeader
        actions={
          <Button
            aria-label="Refresh scheduled jobs"
            disabled={state.loading}
            onClick={() => void refresh()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-3.5 ${state.loading ? "animate-spin" : ""}`}
            />
          </Button>
        }
        status={
          <SiteHeaderStatus>Live · refreshes every {REFRESH_INTERVAL_MS / 1000}s</SiteHeaderStatus>
        }
      />

      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
        {state.error ? (
          <div
            className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-background px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 flex-1 break-words">{state.error}</p>
            <Button onClick={() => void refresh()} size="sm" type="button" variant="outline">
              Retry
            </Button>
          </div>
        ) : null}

        {overview === null ? (
          state.error ? null : (
            <BoardSkeleton />
          )
        ) : isEmpty ? (
          <BoardEmptyState />
        ) : (
          <div className="space-y-8">
            <RunningSection runs={overview.running} />
            <UpcomingSection jobs={overview.upcoming} />
            <PastSection runs={overview.past} />
          </div>
        )}
      </div>
    </main>
  );
}

function RunningSection({ runs }: { runs: ScheduledJobRun[] }) {
  return (
    <section>
      <SectionHeading count={runs.length} title="Running now" />

      {runs.length === 0 ? (
        <EmptyNote>Nothing is running right now.</EmptyNote>
      ) : (
        <div className="mt-2 space-y-2">
          {runs.map((run) => (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/80 px-3 py-2.5"
              key={run.id}
            >
              <span aria-hidden="true" className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              <p
                className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground"
                title={run.taskTitle}
              >
                {run.taskTitle}
              </p>
              <span className="text-[11px] text-muted-foreground">
                {payloadKindLabel(run.payloadKind)}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                started {formatTimestamp(run.startedAt)} · {formatRelative(run.startedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function UpcomingSection({ jobs }: { jobs: UpcomingScheduledJob[] }) {
  return (
    <section>
      <SectionHeading count={jobs.length} title="Up next" />

      {jobs.length === 0 ? (
        <EmptyNote>No active tasks are scheduled to run.</EmptyNote>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-border/80">
          <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/80 text-[11px] text-muted-foreground">
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Next run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {jobs.map((job) => (
                <tr key={job.taskId}>
                  <td
                    className="max-w-64 truncate px-3 py-2 font-medium text-foreground"
                    title={job.taskTitle}
                  >
                    {job.taskTitle}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{scheduleLabel(job)}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {job.nextRunAt ? (
                      <>
                        {formatTimestamp(job.nextRunAt)} · {formatRelative(job.nextRunAt)}
                        {job.queued ? (
                          <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                            queued
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-destructive">nothing queued</span>
                        <span className="block text-[11px] text-muted-foreground">
                          Requeued when the worker restarts.
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PastSection({ runs }: { runs: ScheduledJobRun[] }) {
  return (
    <section>
      <SectionHeading count={runs.length} title="Past runs" />

      {runs.length === 0 ? (
        <EmptyNote>No runs have finished yet.</EmptyNote>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-border/80">
          <table className="w-full min-w-[48rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/80 text-[11px] text-muted-foreground">
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {runs.map((run) => (
                <tr key={run.id}>
                  <td
                    className="max-w-56 truncate px-3 py-2 font-medium text-foreground"
                    title={run.taskTitle}
                  >
                    {run.taskTitle}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getRunStatusClasses(run.status)}`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                    {formatTimestamp(run.startedAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                    {formatDuration(run.startedAt, run.completedAt)}
                  </td>
                  <td className="max-w-96 px-3 py-2 text-muted-foreground">
                    <span className="line-clamp-2" title={getRunResult(run) ?? undefined}>
                      {getRunResult(run) ?? "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BoardSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-8">
      <div className="animate-pulse">
        <div className="h-3.5 w-28 rounded bg-muted" />
        <div className="mt-3 h-9 rounded-md bg-muted" />
      </div>
      <div className="animate-pulse">
        <div className="h-3.5 w-20 rounded bg-muted" />
        <div className="mt-3 h-24 rounded-lg bg-muted" />
      </div>
      <div className="animate-pulse">
        <div className="h-3.5 w-24 rounded bg-muted" />
        <div className="mt-3 h-40 rounded-lg bg-muted" />
      </div>
    </div>
  );
}

function BoardEmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
      <CalendarClock aria-hidden="true" className="size-8 text-muted-foreground" />
      <h2 className="text-sm font-semibold text-foreground">No scheduled jobs yet</h2>
      <p className="text-sm text-muted-foreground">
        When the agent schedules work, live runs, upcoming fires, and run history appear here.
      </p>
      <Link className={cn(buttonVariants({ size: "sm" }))} href="/">
        Open chat
      </Link>
    </div>
  );
}

function SectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <h2 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
      {title}
      <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
    </h2>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function scheduleLabel(job: UpcomingScheduledJob) {
  if (job.scheduleType === "cron") {
    return `Recurring · cron ${job.cron} (${job.timezone})`;
  }

  if (job.payload.kind === "instruction") {
    return `Check-in · round ${job.payload.round}/${job.payload.maxRounds}`;
  }

  return "One-off";
}

function payloadKindLabel(kind: ScheduledJobRun["payloadKind"]) {
  return kind === "instruction" ? "check-in" : "tool call";
}

/** Failed runs show the error; instruction verdicts show their statusUpdate. */
function getRunResult(run: ScheduledJobRun) {
  if (run.error) {
    return run.error;
  }

  const statusUpdate = extractStatusUpdate(run.output);

  if (statusUpdate) {
    return statusUpdate;
  }

  if (run.output === null || run.output === undefined) {
    return null;
  }

  const text = JSON.stringify(run.output);

  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function getRunStatusClasses(status: ScheduledJobRun["status"]) {
  switch (status) {
    case "running":
      return "bg-primary/10 text-primary";
    case "completed":
      return "bg-primary/10 text-primary";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "skipped":
      return "bg-muted text-muted-foreground";
  }
}

function formatRelative(value: string) {
  const diffMs = new Date(value).getTime() - Date.now();

  if (Number.isNaN(diffMs)) {
    return "";
  }

  const seconds = Math.round(Math.abs(diffMs) / 1000);
  const text =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.round(seconds / 60)}m`
        : seconds < 86400
          ? `${(seconds / 3600).toFixed(1)}h`
          : `${(seconds / 86400).toFixed(1)}d`;

  return diffMs < 0 ? `${text} ago` : `in ${text}`;
}

function formatDuration(startedAt: string, completedAt: string | null) {
  if (!completedAt) {
    return "—";
  }

  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();

  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }

  const seconds = ms / 1000;

  if (seconds < 1) {
    return "<1s";
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${Math.round(seconds % 60)}s`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
