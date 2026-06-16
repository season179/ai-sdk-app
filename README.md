# ai-sdk-app

A sandbox for the [Vercel AI SDK](https://ai-sdk.dev). I run production apps with real users on the AI SDK, and the framework moves fast — I started on v4, v6 is current, and v7 is on the way. Breaking changes and new agent patterns can't be trialled on production users, so they get proven out here first and then ported over to the real apps.

The app itself is a small Next.js App Router chat: TypeScript, React 19, Tailwind CSS 4, AI Elements-style components, and AI SDK v6 with OpenRouter.

## Experiments

### Tool search

Inspired by [tool search in Nous Research's Hermes agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search). Instead of sending the model every tool schema up front, the chat agent gets a compact tool-search bridge: a local BM25 index over a catalog of 200 partially-real, mock-backed tools, which the model queries to discover and load only the tools a task actually needs. Set `TOOL_EXPOSURE_MODE=all` to send every schema instead, as a baseline for comparing token usage.

### Agent skills in Postgres

Agent skills are conventionally files on disk. That doesn't translate well to my production setup — dockerised apps on Kubernetes, where depending on a writable, persistent filesystem per pod is exactly what I want to avoid. The experiment here stores skills in Postgres instead: the chat runtime loads skills from the database, and there's a management UI at `/skills` with a detail editor, a references tier, and per-skill token measurement.

### Scheduled tasks

Real (non-mock) scheduler tools backed by pg-boss, in the same catalog the tool search exposes. See [Scheduled Tasks](#scheduled-tasks) below for details.

## Setup

1. Use pnpm 11. This repo pins `packageManager` to `pnpm@11.5.1`.
2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Create `.env` from `.env.example` and fill the OpenRouter values:

   ```bash
   OPENROUTER_API_KEY=...
   OPENROUTER_DEFAULT_MODEL=...
   TOOL_EXPOSURE_MODE=search

   DATABASE_URL=postgres://ai_sdk_app:ai_sdk_app@localhost:5433/ai_sdk_app
   PGBOSS_SCHEMA=pgboss
   DEFAULT_SCHEDULE_TIMEZONE=UTC
   ```

   `OPENROUTER_DEFAULT_MODEL` is used directly as the chat model. The app intentionally fails with a clear server error if either variable is missing.
   `TOOL_EXPOSURE_MODE` is optional. `search` sends only the tool-search bridge tools; `all` sends every mock-backed tool schema for baseline comparison.
   The `DATABASE_URL` block is only needed for scheduled tasks and skills. Any Postgres works — the defaults match the optional `docker-compose.yml`.

4. Start Postgres, run migrations, and start the scheduled-task worker (only needed for scheduled tasks and skills). If you already run Postgres, point `DATABASE_URL` at it and skip the Docker step:

   ```bash
   docker compose up -d  # optional: only if you don't have a local Postgres
   pnpm db:migrate
   pnpm worker:scheduled-tasks
   ```

   Our tables (`agent_scheduled_tasks`, `agent_scheduled_task_runs`, `agent_skills`) are
   the typed Drizzle data-access layer defined in `db/schema.ts`. The schema is the
   source of truth: `pnpm db:generate` writes a migration to `db/drizzle/`, and
   `pnpm db:migrate` applies it. The baseline migration is idempotent, so `pnpm db:migrate`
   is safe on a fresh database and on one that already has the tables. pg-boss still owns
   its `pgboss` schema and is not modeled by Drizzle. The legacy raw SQL under
   `db/migrations/` is kept for history only (see `db/migrations/README.md`).

5. Start the app:

   ```bash
   pnpm dev
   ```

6. Open `https://ai-sdk-app.dev` and send a message.

`pnpm dev` runs through Portless and serves the app at a stable HTTPS `.dev` URL. Portless assigns the underlying Next.js process a random app port, so this project does not need to reserve `3000` or `3001`.

If you need to bypass Portless while debugging, run the raw Next.js server with:

```bash
pnpm run dev:app
```

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm build
```

The `/api/chat` route uses `ToolLoopAgent` with `createAgentUIStreamResponse()`. By default it exposes a local BM25 tool-search bridge over 200 partially real mock-backed tools, and returns `x-openrouter-model`, `x-mock-tools`, `x-total-tools`, and `x-tool-exposure-mode` response headers for local verification.

## Scheduled Tasks

The agent has six real (pg-boss-backed) scheduler tools in the same catalog: `scheduled_task_create`, `scheduled_task_list`, `scheduled_task_cancel`, `scheduled_task_pause`, `scheduled_task_resume`, and `scheduled_task_get_runs`. Tasks run a stored catalog tool call (`payload.kind = 'tool_call'`) either once (`run_at`) or on a cron schedule with an IANA timezone.

- Architecture and decisions: `docs/pg-boss-scheduled-tasks-plan.md`
- App state lives in `agent_scheduled_tasks` / `agent_scheduled_task_runs`; pg-boss owns queue state in the `pgboss` schema.
- The worker (`pnpm worker:scheduled-tasks`) must be running for tasks to execute. Failed runs retry twice with backoff, then land in the `agent-task-run-dlq` queue.
- Downtime is handled launchd-style: cron fires that stack up while no worker is consuming coalesce into a single queued job (`stately` queue policy + per-task singleton keys), and at startup the worker queues one catch-up run for any cron fire missed during a full outage (`lib/scheduler/catchup.ts`). However long the gap, each task catches up at most once. One-off tasks keep their queued job and simply run on recovery.
- The header Tasks panel and `GET/POST /api/scheduled-tasks`, `PATCH/DELETE /api/scheduled-tasks/:id`, `GET /api/scheduled-tasks/:id/runs` use the same service as the chat tools.
- `scripts/smoke-scheduler.ts` is a quick end-to-end check (requires Postgres and the worker).
