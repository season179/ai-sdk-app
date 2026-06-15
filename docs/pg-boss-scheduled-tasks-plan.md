# pg-boss Scheduled Tasks Plan

## Objective

Give the agent a real scheduled-task capability while preserving the repo's current purpose: a focused Next.js chat harness for tool-search experiments. The first version should let the agent create, list, cancel, and inspect scheduled tasks without turning the UI into a production dashboard.

## Current Context

- The app is a Next.js App Router chat surface using OpenRouter, the AI SDK, and a tool-search bridge.
- Existing tools are realistic but mock-backed; scheduled tasks should be the first real side-effecting tool surface.
- The app currently has no database dependency, so adding pg-boss also means introducing Postgres configuration and a long-running worker process.

## pg-boss Facts To Design Around

- Use `pg-boss@12.18.2` or newer in the same major version unless a later compatibility check says otherwise.
- pg-boss currently requires Node 22.12+ and PostgreSQL 13+.
- Recurring schedules use `boss.schedule(name, cron, data, options)`.
- One-off future jobs should use `boss.sendAfter(name, data, options, date)` or `boss.send(..., { startAfter })`.
- Recurring schedules can be removed with `boss.unschedule(name, key)`.
- Schedules can be inspected with `boss.getSchedules(name, key)`.
- The `name` argument is the queue name. Use `options.key` as the app's task id so multiple schedules can target the same queue.
- Use `options.tz` for cron timezone. Default to `UTC` unless the UI or user explicitly supplies a timezone.
- pg-boss workers and the Timekeeper should run in a long-lived worker process, not inside request handlers.

Sources checked on 2026-06-07:

- https://github.com/timgit/pg-boss
- https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/jobs.md
- https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/workers.md
- https://raw.githubusercontent.com/timgit/pg-boss/master/src/index.ts
- https://deepwiki.com/timgit/pg-boss

## Proposed Architecture

### 1. Environment And Dependencies

Add:

```bash
pnpm add pg-boss
```

Add these environment variables:

```bash
DATABASE_URL=
PGBOSS_SCHEMA=pgboss
DEFAULT_SCHEDULE_TIMEZONE=UTC
```

Keep OpenRouter configuration separate from queue configuration. The chat route should fail clearly if OpenRouter env is missing; the scheduler should fail clearly if database env is missing.

### 2. App-Owned Task Tables

pg-boss owns queue execution state, but the product should have its own task records. Add app tables for durable user-facing state:

```sql
create table agent_scheduled_tasks (
  id uuid primary key,
  title text not null,
  instruction text not null,
  schedule_type text not null check (schedule_type in ('once', 'cron')),
  run_at timestamptz,
  cron text,
  timezone text not null default 'UTC',
  status text not null check (status in ('active', 'paused', 'cancelled')),
  queue_name text not null,
  schedule_key text,
  job_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agent_scheduled_task_runs (
  id uuid primary key,
  task_id uuid not null references agent_scheduled_tasks(id),
  pg_boss_job_id uuid not null,
  status text not null check (status in ('running', 'completed', 'failed', 'skipped')),
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (pg_boss_job_id)
);
```

This gives the UI and agent a stable source of truth without querying pg-boss internals directly.

### 3. pg-boss Client Module

Create a small server-only module:

- `lib/scheduler/boss.ts`
- exports `getBoss()` (starts pg-boss lazily on first call) and `stopBoss()`
- validates `DATABASE_URL`
- sets `schema` from `PGBOSS_SCHEMA`
- attaches `error` and `warning` listeners

The API process can use this for schedule creation and cancellation. Worker registration should live outside request handling.

### 4. Scheduling Service

Create `lib/scheduler/tasks.ts` with functions:

- `createScheduledTask(input)`
- `cancelScheduledTask(id)`
- `listScheduledTasks()`
- `getScheduledTaskRuns(taskId)`

Queue names:

- `agent-task-run`
- `agent-task-run-dlq`

Creation behavior:

- For one-off tasks, insert the app row, then call `boss.sendAfter("agent-task-run", { taskId }, options, runAt)`.
- For recurring tasks, insert the app row, then call `boss.schedule("agent-task-run", cron, { taskId }, { key: taskId, tz })`.
- Configure retries and dead-letter behavior at the queue level with `createQueue`.
- Store the pg-boss job id for one-off tasks and `taskId` as the recurring schedule key.

Cancellation behavior:

- Mark the app task `cancelled`.
- For one-off tasks, call `boss.cancel("agent-task-run", jobId)` when a job id exists.
- For recurring tasks, call `boss.unschedule("agent-task-run", taskId)`.

### 5. Worker Process

Add `workers/scheduled-tasks.ts` and a package script:

```json
{
  "scripts": {
    "worker:scheduled-tasks": "tsx workers/scheduled-tasks.ts"
  }
}
```

If the worker is run directly from TypeScript, add a runner such as `tsx` as a dev dependency. Otherwise compile the worker before running it in production.

The worker should:

1. start pg-boss
2. create both queues
3. register `boss.work("agent-task-run", { pollingIntervalSeconds: 2 }, handler)`
4. handle `SIGINT` and `SIGTERM` with `boss.stop()`

Handler behavior:

1. load the app task by id
2. skip cancelled or paused tasks
3. create a run row keyed by `pg_boss_job_id`
4. execute the stored instruction
5. store output or error

V1 execution should be conservative. Prefer one of these:

- safer V1: only allow scheduled execution of explicit tool name plus arguments
- broader V1: run the stored instruction through `ToolLoopAgent`, but disable scheduler tools during scheduled execution to avoid recursive task creation

### 6. Agent Tools

Add real scheduler tools to the bridge:

- `scheduled_task_create`
- `scheduled_task_list`
- `scheduled_task_cancel`
- `scheduled_task_get_runs`

Implementation path:

- Extend the catalog with scheduler tool specs.
- Route these tool names to the scheduling service from `tool_call`.
- Keep the existing mock-backed tools unchanged.
- Make scheduler tool outputs explicit about whether a task is one-off or recurring, what timezone is used, and whether creation succeeded.

The system prompt should instruct the model to ask a follow-up question when the user's requested time is ambiguous.

### 7. API Routes

Add thin route handlers for non-chat access:

- `GET /api/scheduled-tasks`
- `POST /api/scheduled-tasks`
- `DELETE /api/scheduled-tasks/:id`
- `GET /api/scheduled-tasks/:id/runs`

The chat tool path and direct API path should call the same scheduling service so behavior stays consistent.

### 8. UI Surface

Keep the chat as the first screen. Add a compact Tasks panel with:

- task title
- one-off or recurring label
- scheduled time or cron string
- timezone
- status
- last run state
- cancel action

Only show "next run" if it is derived from the cron expression. Do not ship decorative task metadata.

### 9. Verification

Run:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

Use `agent-browser` for browser verification:

1. start Postgres and the scheduled-task worker
2. start the Next app
3. ask the agent to create a one-off task for about 10 seconds in the future
4. confirm the task appears in the Tasks panel
5. wait for execution
6. confirm a run appears with completed or failed state
7. create a recurring minute-level task
8. cancel it
9. confirm no further runs are created after cancellation

## Suggested Implementation Slices

1. Add Postgres and pg-boss wiring with a worker that can process a hard-coded test job.
2. Add app task tables and the scheduling service.
3. Add scheduler tools through the existing tool-search bridge.
4. Add the compact Tasks panel.
5. Add end-to-end verification with `agent-browser`.

## Decisions (resolved 2026-06-07)

- **Migrations:** raw SQL scripts in `db/migrations/` with a tiny runner (`scripts/migrate.ts`, `pnpm db:migrate`) tracking applied files in `schema_migrations`.
- **V1 execution:** explicit tool calls only, stored as a discriminated `payload jsonb` (`{ "kind": "tool_call", "toolName", "arguments" }`) instead of the `instruction text` column drafted above. The worker dispatches on `payload.kind`, so a future `instruction` kind (agent-loop execution) is a new dispatcher branch, not a migration — deliberately a two-way door.
- **Pause/resume:** included in V1 for both task types. Pause unschedules (cron) or cancels the pending job (one-off); resume re-schedules or sends a fresh job (one-off resume requires `run_at` still in the future). A `completed` status was also added for one-off tasks that ran.
- **Deployment:** local-only. Postgres via `docker-compose.yml` (port 5433), worker via `pnpm worker:scheduled-tasks`.

## Implementation Notes (post-build)

- pg-boss v12 uses a named export (`import { PgBoss } from "pg-boss"`), and `createQueue(name, options)` takes options without `name`.
- The chat system prompt includes the current UTC time per request; without it the model cannot resolve relative times like "in 20 seconds".
- Reusing one SQL parameter for the uuid `id` and text `schedule_key` columns fails with `42P08 inconsistent types deduced` — the insert passes the id as two parameters.
- Scheduler tool errors return `{ success: false, error }` to the model instead of throwing, so the agent can recover (observed live: it retried with a later `run_at` after a "runAt must be in the future" rejection).

## Missed-run coalescing (added 2026-06-11)

Downtime handling is launchd-style: each cron task runs at most once on recovery, however long the outage. The recipe above predates this — the queue and call conventions changed:

- The task queue uses pg-boss's `stately` policy, and **every send or schedule must carry the task id as its singleton key** via `taskSendOptions` / `taskScheduleOptions` from `lib/scheduler/boss.ts`. Under `stately`, keyless jobs share one queue-wide slot, so a bare `send`/`schedule` silently swallows other tasks' jobs.
- Stacked fires (worker down, web up) coalesce into one queued job at insert time. Full-outage misses are recovered by `lib/scheduler/catchup.ts` at worker startup: it re-asserts schedules, migrates pre-`stately` queues (createQueue can't change an existing policy), and queues at most one catch-up run per task — judged on the database clock against the latest run / task update.
- Accepted trade-offs: a job failing while an earlier same-key job still sits in `retry` goes straight to the DLQ (the retry slot is occupied — see pg-boss `failJobs`' `ON CONFLICT DO NOTHING`); jobs queued before the one-time policy flip are exempt from coalescing during that upgrade window.

## Instruction payloads and self-chaining check-ins (planned and shipped 2026-06-12)

Adds the deferred `instruction` payload kind. Motivating example: "check in on x every 60s" — the agent schedules a one-off that fires in 60s; at fire time an agent loop checks on x, reports status, and judges whether another round is warranted. `tool_call` payloads are unchanged and remain the right choice for deterministic replays; `instruction` is a new dispatcher branch in `lib/scheduler/execute.ts`, exactly the two-way door the V1 decision reserved.

### Trust boundary

The model judges; deterministic worker code performs every schedule mutation. Scheduled execution gets **no scheduler tools** — this keeps the V1 recursion decision intact while still allowing recurrence:

- The instruction run must end with a structured verdict (enforced output schema, not prose):

  ```json
  { "statusUpdate": "...", "continue": true, "nextDelaySeconds": 60 }
  ```

- The worker acts on the verdict. Stopping is `continue: false` — cancellation is convergent (can only reduce work), so it needs no tool either.

### Payload shape

```json
{
  "kind": "instruction",
  "instruction": "check in on x every 60s",
  "round": 3,
  "maxRounds": 20,
  "cadenceSeconds": 60
}
```

Chain state lives in the task's `payload` jsonb (worker updates `round` per fire) — no migration. `instruction` is orthogonal to `schedule_type`:

- **`once` + instruction (self-chaining):** on `continue: true`, the worker sends the successor job (`sendAfter`, singleton key = task id per the stately rules below), increments `round`, and the task stays `active`. On `continue: false`, mark the task `completed`.
- **`cron` + instruction:** the cron schedule provides recurrence; the worker never sends successors. `continue: false` maps to the existing `cancelScheduledTask()`.

### Round counter = context + cap

`round`/`maxRounds` does double duty: it is injected into the prompt ("round 7 of 20", so the model can pace itself and wrap up cleanly on the final round) and it is the hard guardrail — the worker refuses to schedule past `maxRounds` regardless of the verdict. `nextDelaySeconds` is clamped to a floor (default 30s) so a confused model cannot tighten the loop.

### Fire-time prompt context

The worker assembles: the original instruction verbatim, current UTC time (same treatment the chat route already has — without it relative phrasing is meaningless), round N of M, chain start time and intended cadence, and the previous run's `output` (read from `agent_scheduled_task_runs`; do not accumulate history into the payload). Last-round output is what turns a stateless check into a real status update ("80% last round, now 85%").

### Failure policy and chain liveness

Self-chaining one-offs break in a way cron does not: the entire recurrence lives in the single pending job. Two measures:

- **No rethrow for instruction runs.** The handler catches execution errors, records the run `failed`, and still schedules the next round (failure consumes a round). This trades pg-boss retry/DLQ for a single decision point per fire and keeps recurrence alive through transient LLM outages. A consecutive-failure limit (default 3) stops hopeless chains.
- **Catch-up re-asserts chain liveness.** Invariant: an `active` instruction-chain task has exactly one pending job. `lib/scheduler/catchup.ts` (which today only re-asserts cron schedules) additionally queues one job at worker startup for any active chain task with no pending job.

### Carried-over constraints

- Every successor `sendAfter` must use `taskSendOptions(taskId)` — under the `stately` policy a keyless send silently collides (see 2026-06-11 section). Successors are sent only after the prior job completes, so the singleton slot is free.
- The worker now needs OpenRouter env in addition to `DATABASE_URL`. Fail at startup with a clear message, same standard as the chat route.

### Surface changes

- `scheduled_task_create` (tool + POST route) accepts the new payload kind; validation requires non-empty `instruction` and sane `maxRounds`.
- System prompt: prefer `tool_call` for single deterministic calls; use `instruction` when the task needs judgment, multiple steps, or a stop condition.
- Tasks panel: show round N/M for chains; `statusUpdate` lands in the run's `output` and is shown on the last-run line.
- Accepted limitation: there is no push channel into the chat — status updates are visible only in the Tasks panel / runs API.

### Implementation notes (post-build)

- The agent loop is `ToolLoopAgent` with `output: Output.object({ schema })` (AI SDK v6; `experimental_output` is deprecated); the verdict is read from `result.output`. All three verdict fields are required in the schema because strict structured-output providers reject optional properties — `nextDelaySeconds` is simply ignored when `continue` is false.
- Instruction runs get the mock catalog only. Reusing the tool-search bridge was rejected: its `tool_call` dispatcher routes to scheduler tools, which would leak scheduling back into scheduled execution.
- Delay clamping is `[30s, 24h]` (ceiling added beyond the planned floor); `cadenceSeconds` is validated to the same window at create time. `payload.round` is the round number of the *next* fire; the worker advances it before sending the successor, so a crash between the two can only skip a round number, never replay one.
- Stop semantics: verdict/cap stop marks a `once` chain `completed` and cancels a `cron` one; the consecutive-failure stop marks the task `cancelled` (abnormal end). Chain mutations after a round never rethrow — a failed successor send is logged and healed by startup catch-up.
- Resuming a paused `once` + instruction chain re-enters after one cadence delay instead of requiring `run_at` to still be in the future (mid-chain, `run_at` is the long-past first fire).
- Verified live on 2026-06-12: a two-round chain ran end to end (round 2's prompt visibly used round 1's output), and a deliberately broken chain (active task, pending job cancelled directly in `pgboss.job`) was revived at worker startup by the liveness reconciler.
