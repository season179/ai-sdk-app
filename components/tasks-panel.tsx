"use client";

import { CalendarClock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { extractStatusUpdate, formatTimestamp } from "@/lib/scheduler/display";
import type { ScheduledTask } from "@/lib/scheduler/tasks";

const REFRESH_INTERVAL_MS = 10_000;

type PanelState = {
  tasks: ScheduledTask[];
  loading: boolean;
  error: string | null;
};

export function TasksPanel() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PanelState>({ tasks: [], loading: false, error: null });
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));

    try {
      const response = await fetch("/api/scheduled-tasks");
      const body: { tasks?: ScheduledTask[]; error?: string } = await response.json();

      if (!response.ok || !body.tasks) {
        throw new Error(body.error ?? "Failed to load scheduled tasks.");
      }

      setState({ tasks: body.tasks, loading: false, error: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load scheduled tasks.",
      }));
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    void refresh();
    const interval = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [open, refresh]);

  async function runTaskAction(task: ScheduledTask, action: "cancel" | "pause" | "resume") {
    setPendingTaskId(task.id);

    try {
      const init: RequestInit =
        action === "cancel"
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action }),
            };
      const response = await fetch(`/api/scheduled-tasks/${task.id}`, init);
      const body: { error?: string } = await response.json();

      if (!response.ok) {
        throw new Error(body.error ?? `Failed to ${action} the task.`);
      }

      await refresh();
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : `Failed to ${action} the task.`,
      }));
    } finally {
      setPendingTaskId(null);
    }
  }

  return (
    <details className="relative shrink-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary/30 [&::-webkit-details-marker]:hidden">
        <CalendarClock aria-hidden="true" className="size-3.5" />
        Tasks
        <span className="font-semibold tabular-nums text-foreground">
          {state.tasks.filter((task) => task.status === "active").length}
        </span>
      </summary>

      <div className="absolute right-0 top-full z-20 mt-3 w-[min(calc(100vw-2rem),26rem)] rounded-lg border border-border bg-background p-4 text-left shadow-[0_24px_70px_-36px_rgba(15,23,42,0.45)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Scheduled tasks</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Real pg-boss tasks created by the agent or API.
            </p>
          </div>
          <Button
            aria-label="Refresh tasks"
            disabled={state.loading}
            onClick={() => void refresh()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw className={`size-3.5 ${state.loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {state.error ? (
          <p className="mt-3 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
            {state.error}
          </p>
        ) : null}

        <div className="mt-3 max-h-80 space-y-2 overflow-y-auto">
          {state.tasks.length === 0 && !state.loading ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              No scheduled tasks yet. Ask the agent to schedule one.
            </p>
          ) : (
            state.tasks.map((task) => (
              <TaskCard
                key={task.id}
                onAction={(action) => void runTaskAction(task, action)}
                pending={pendingTaskId === task.id}
                task={task}
              />
            ))
          )}
        </div>
      </div>
    </details>
  );
}

function TaskCard({
  task,
  pending,
  onAction,
}: {
  task: ScheduledTask;
  pending: boolean;
  onAction: (action: "cancel" | "pause" | "resume") => void;
}) {
  const isRecurring = task.scheduleType === "cron";
  const canPause = task.status === "active";
  const canResume = task.status === "paused";
  const canCancel = task.status === "active" || task.status === "paused";

  return (
    <div className="rounded-md border border-border/80 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold text-foreground" title={task.title}>
          {task.title}
        </p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${getStatusClasses(task.status)}`}
        >
          {task.status}
        </span>
      </div>

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">
          {isRecurring ? "Recurring" : "One-off"}
        </span>{" "}
        ·{" "}
        {isRecurring
          ? `cron ${task.cron} (${task.timezone})`
          : task.runAt
            ? `runs ${formatTimestamp(task.runAt)}`
            : "no run time"}
      </p>

      {task.payload.kind === "instruction" ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">Check-in</span> · round{" "}
          {task.payload.round}/{task.payload.maxRounds}
          {task.payload.cadenceSeconds ? ` · every ~${task.payload.cadenceSeconds}s` : ""}
        </p>
      ) : null}

      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
        Last run:{" "}
        {task.lastRun
          ? `${task.lastRun.status} ${formatTimestamp(task.lastRun.startedAt)}`
          : "never"}
        {task.lastRun?.error ? ` — ${task.lastRun.error}` : ""}
        {extractStatusUpdate(task.lastRun?.output)
          ? ` — ${extractStatusUpdate(task.lastRun?.output)}`
          : ""}
      </p>

      {canCancel ? (
        <div className="mt-2 flex gap-2">
          {canPause ? (
            <Button
              disabled={pending}
              onClick={() => onAction("pause")}
              size="sm"
              type="button"
              variant="outline"
            >
              Pause
            </Button>
          ) : null}
          {canResume ? (
            <Button
              disabled={pending}
              onClick={() => onAction("resume")}
              size="sm"
              type="button"
              variant="outline"
            >
              Resume
            </Button>
          ) : null}
          <Button
            disabled={pending}
            onClick={() => onAction("cancel")}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function getStatusClasses(status: ScheduledTask["status"]) {
  switch (status) {
    case "active":
      return "bg-emerald-500/15 text-emerald-600";
    case "paused":
      return "bg-amber-500/15 text-amber-600";
    case "completed":
      return "bg-sky-500/15 text-sky-600";
    case "cancelled":
      return "bg-muted text-muted-foreground";
  }
}
