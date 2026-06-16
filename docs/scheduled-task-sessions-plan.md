# Implementation Plan — Scheduled tasks that live in a session

> **Audience:** an AI coding agent (or engineer) implementing this without prior context.
> **Status:** approved plan, not yet implemented. No code has been written yet.
> **Repo:** Next.js 16 + AI SDK v6 (`ai`) + Drizzle ORM + Postgres + pg-boss. Package manager **pnpm**, Node 24.

---

## How to use this doc

1. Read **Goal**, **Why it's blocked today**, and **Target architecture** first — they explain *why* every change below exists.
2. Implement in the **Build order** sequence (Phase 1 → 2 → 3). Phase 1 is the keystone; nothing else is safe until it lands.
3. Each task lists the **exact files** (with current `path:line` anchors) and the **target shape**. Code blocks are illustrative targets, not literal patches — read the current file and adapt.
4. Honor the **Approved decisions** (K1/K2/K3) and read the **Risks** for each — two of them (K2, K3) were chosen against the author's recommendation; the trade-offs are documented so you don't re-discover them the hard way.
5. Finish against the **Acceptance criteria**.

A visual version of this plan exists at `.lavish/session-plan.html` (open with `lavish-axi <file>` for a rendered review surface). This markdown is the source of truth for implementation.

---

## Goal

A scheduled task's work must land in a **durable, reopenable conversation** — its **home session** — appended as one **turn per round**, viewable and continuable in the normal chat UI, updating live while open.

The headline scenario: in chat session `123` a user says *"tell me a joke every 10s."* The agent creates a scheduled task; each fired round appends a joke **into chat 123**. A task created without an originating chat (via API or the tasks UI) instead gets its **own dedicated session**.

This is the durable, server-side equivalent of how Claude Code's `/loop` fires a scheduled prompt as a turn into the session that owns it (append-only, single-writer).

---

## Why it's blocked today

Chat persistence is **client-authoritative**: the browser holds the full transcript and resends it every turn; the server rewrites the whole thing with delete-all-then-insert.

- `lib/chat/sessions.ts:142` — `saveChatSession` deletes all messages for the session and re-inserts the client's array, reassigning ordinals (`ordinal: index`).
- `app/api/chat/route.ts:221` — `onFinish` persists `[...messages, responseMessage]` where `messages` is the client-sent array.
- `db/schema.ts:179` — `ordinal` is "ordering only … deliberately NOT unique" precisely because the whole transcript is rewritten each save.

**Consequence:** a second writer (the scheduled-task worker) cannot add a turn. Even if it inserted a row, the user's next turn would rewrite the transcript from the client array and wipe it. And there is no push channel, so an open tab would never see it.

The fix is not a workaround — it is to make the **server own the transcript** and **append** turns. Everything else depends on this.

---

## Target architecture

**Server-authoritative, append-only, single primitive, two writers.**

```
Today                                  Target
─────                                  ──────
browser holds full transcript          browser sends only the new turn
  └─ POST { messages: [all], id }         └─ POST { message: <new>, id, trigger }
chat route → saveChatSession            chat route → loads history, runs agent,
  (delete-all-then-insert)                appendSessionMessages([userTurn, assistantTurn])
worker → stores verdict string only     worker → appendSessionMessages([marker, ...roundTurns])
  ✕ cannot reach the session              into the task's HOME session
                                        open tab ← SSE stream pushes new turns live
```

- **Home session** of a task = `origin_session_id` (the chat that created it) **if set**, else a **dedicated session** the task owns (`origin = 'scheduled_task'`, `task_id = <task>`).
- Both writers use the same `appendSessionMessages` primitive (continuing ordinals, idempotent by message id). No rewrite → no clobber.
- Scheduled turns are tagged (`metadata.origin = 'scheduled'`) so the UI renders them distinctly and edit-truncation can treat them specially.

---

## Approved decisions

| ID | Decision | Chosen | Note |
|----|----------|--------|------|
| **K1** | Delivery shape | **Build straight through** (Phase 1 → 2 → 3) | Author-recommended. |
| **K2** | Live-update channel | **SSE stream** via Postgres `LISTEN/NOTIFY` | Chosen over poll-first. See K2 risk. |
| **K3** | Edits to a session a task writes into | **Preserve scheduled turns across edits** | Chosen over simple truncate. See K3 risk. |

> **K2 author note (dissent, recorded):** SSE only beats polling if backed by `LISTEN/NOTIFY`; otherwise it's a server-side poll in disguise. It adds an endpoint, connection lifecycle (reconnect, heartbeat), and a dedicated DB connection per listener (breaks under transaction-mode poolers like PgBouncer). Acceptable for this single-user, long-running-server setup. If SSE proves fiddly, `use-smart-poll` (`lib/hooks/use-smart-poll.ts`) is a drop-in fallback.

> **K3 author note (dissent, recorded):** Preserving scheduled turns generated under an *old* instruction after a human edit means the agent re-runs on edited history while seeing outputs it wouldn't have produced — future turns reason over an inconsistent transcript. The simpler "truncate strictly after the edited ordinal" avoids this, and **nothing is actually lost**: every round is durably recorded in `agent_scheduled_task_runs` independent of the chat transcript. Implement K3 as approved, but keep the desync risk in mind and isolate the re-stitch logic so it's easy to revert to plain truncation.

---

## Data model changes

Edit `db/schema.ts`, then generate + apply a migration (see **Migrations** below). Three nullable additions, no new tables.

### `agent_chat_sessions` (currently `db/schema.ts:134`)

Add:
- `origin text not null default 'chat'` — `'chat' | 'scheduled_task'`. Add a CHECK constraint mirroring the existing enum-style checks.
- `task_id uuid` — set only for dedicated task sessions. FK → `agent_scheduled_tasks.id`. Partial-unique (one dedicated session per task).

```ts
export type ChatSessionOrigin = "chat" | "scheduled_task";

// inside agentChatSessions columns:
origin: text("origin").$type<ChatSessionOrigin>().notNull().default("chat"),
task_id: uuid("task_id").references((): AnyPgColumn => agentScheduledTasks.id),

// inside the table-extras array:
check("agent_chat_sessions_origin_check", sql`${t.origin} in ('chat', 'scheduled_task')`),
uniqueIndex("agent_chat_sessions_task_id_uniq").on(t.taskId).where(sql`${t.taskId} is not null`),
```

### `agent_scheduled_tasks` (currently `db/schema.ts:30`)

Add:
- `origin_session_id uuid` — the chat that spawned the task (nullable). FK → `agent_chat_sessions.id`.

```ts
// inside agentScheduledTasks columns:
originSessionId: uuid("origin_session_id").references((): AnyPgColumn => agentChatSessions.id),
```

> **Circular FK:** sessions → tasks (`task_id`) and tasks → sessions (`origin_session_id`). Both columns are nullable and the rows are inserted in separate statements, so no deferrable constraint is needed. Use Drizzle's `(): AnyPgColumn => …` thunk for the forward reference (same pattern already used at `db/schema.ts:94` for the self-referencing `agentSkills.parentId`).

### `ChatMessageMetadata` (in `lib/token-usage.ts`)

Extend the metadata type so scheduled turns are identifiable without a new column:

```ts
// add optional fields:
origin?: "scheduled";
scheduledRound?: number;
taskId?: string;
```

`agent_chat_messages.metadata` is already `jsonb` (`db/schema.ts:174`), so this needs no migration. The K3 truncate predicate and the UI both key off `metadata->>'origin' = 'scheduled'`.

---

## Migrations

- Edit `db/schema.ts`.
- Generate: `pnpm db:generate` (runs `drizzle-kit generate`; config `drizzle.config.ts`, schema `db/schema.ts`, output `db/drizzle/`).
- Apply: `pnpm db:migrate` (runs `tsx scripts/db-migrate.ts`, which applies `db/drizzle/` via `migrate(...)`; idempotent).
- Connection: `process.env.DATABASE_URL`.
- Review the generated SQL before applying — confirm the two FKs land as separate `ALTER TABLE ADD CONSTRAINT` statements (expected for a circular reference).

---

## Build order

### Phase 1 — Append-only foundation (keystone)

**1.1 — Append-only primitives.** `lib/chat/sessions.ts`

Add `appendSessionMessages` (the single write path both writers share) and `truncateConversationAfter` (explicit edit/regenerate truncation — what delete-all-then-insert did implicitly). Replace `saveChatSession` usage; you may remove it once nothing calls it (currently only the chat route does).

```ts
import { and, eq, gt, sql } from "drizzle-orm";

/**
 * Append-only persistence shared by the chat route and the scheduled-task
 * worker. Ordinals continue from the current max; message ids are the PK
 * (composite with sessionId), so onConflictDoNothing makes retries/catch-up
 * idempotent. Two writers never clobber each other because nothing is rewritten.
 */
export async function appendSessionMessages(
  sessionId: string,
  messages: ChatUIMessage[],
  opts: { agentId?: string; createIfMissing?: boolean } = {},
): Promise<void> {
  if (messages.length === 0) return;
  const uniqueIds = new Set(messages.map((m) => m.id));
  if (uniqueIds.size !== messages.length) {
    throw new ChatSessionInputError("Chat messages must have unique ids within a batch.");
  }

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ deletedAt: agentChatSessions.deletedAt })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.id, sessionId));

    if (existing.length === 0) {
      if (!opts.createIfMissing) {
        throw new ChatSessionNotFoundError(sessionId);
      }
      await tx
        .insert(agentChatSessions)
        .values({ id: sessionId, agentId: opts.agentId ?? DEFAULT_AGENT_ID, lastMessageAt: sql`now()` })
        .onConflictDoNothing();
    } else if (existing[0]?.deletedAt) {
      throw new ChatSessionInputError(`Chat session '${sessionId}' was deleted; refusing to append.`);
    }

    const [{ nextOrdinal }] = await tx
      .select({ nextOrdinal: sql<number>`coalesce(max(${agentChatMessages.ordinal}), -1) + 1` })
      .from(agentChatMessages)
      .where(eq(agentChatMessages.sessionId, sessionId));

    await tx
      .insert(agentChatMessages)
      .values(messages.map((m, i) => ({
        id: m.id,
        sessionId,
        role: m.role,
        parts: m.parts,
        metadata: m.metadata ?? null,
        ordinal: Number(nextOrdinal) + i,
      })))
      .onConflictDoNothing();

    await tx
      .update(agentChatSessions)
      .set({ lastMessageAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(agentChatSessions.id, sessionId));
  });
}

/**
 * Edit/regenerate truncation. With preserveScheduled (K3) we keep worker turns
 * (metadata.origin = 'scheduled') and drop only conversational turns after the
 * fork ordinal. See the K3 risk note — this is the part to isolate.
 */
export async function truncateConversationAfter(
  sessionId: string,
  ordinal: number,
  opts: { preserveScheduled?: boolean } = {},
): Promise<void> {
  const conds = [eq(agentChatMessages.sessionId, sessionId), gt(agentChatMessages.ordinal, ordinal)];
  if (opts.preserveScheduled) {
    conds.push(sql`(${agentChatMessages.metadata} ->> 'origin') is distinct from 'scheduled'`);
  }
  await getDb().delete(agentChatMessages).where(and(...conds));
}
```

**1.2 — Server-authoritative chat route.** `app/api/chat/route.ts`

The request contract flips: the client sends only the **new** message; the server loads history, runs the agent, and appends.

- Request body becomes `{ id, message, trigger, messageId }` (single `message`, not `messages[]`). Keep the UUID validation at `route.ts:119`.
- Load prior transcript with `getChatSession(sessionId)` (`lib/chat/sessions.ts:80`). Build the agent input from history + the new message:
  ```ts
  const history = sessionId ? (await getChatSession(sessionId))?.messages ?? [] : [];
  const fullMessages = trigger === "regenerate-assistant-message"
    ? history                                  // re-run on existing history
    : [...history, message];                   // new user turn
  const uiMessages = await injectUserActivatedSkills(fullMessages);
  ```
- On a new user turn, **persist the user message** before/at stream start so it survives a failed stream (optional but recommended); minimally, append `[message, responseMessage]` in `onFinish`.
- `onFinish` (currently `route.ts:209`): replace `saveChatSession([...messages, responseMessage])` with:
  ```ts
  const turn = trigger === "regenerate-assistant-message" ? [responseMessage] : [message, responseMessage];
  await appendSessionMessages(sessionId, turn);
  ```
- **Regenerate/edit:** before running, call `truncateConversationAfter(sessionId, forkOrdinal, { preserveScheduled: true })`. The client must send the fork point (the ordinal or id of the message being regenerated/edited) — see 1.4.
- Title logic (`route.ts:229`) still keys off "first assistant turn while untitled"; compute `assistantCount` from `history` + the new reply instead of the old `persisted` array.

> **Verify against the installed `ai` version:** the exact `useChat`/transport field names for "send only the last message" and the `trigger` values (`submit-user-message`, `regenerate-assistant-message`). Confirm `injectUserActivatedSkills` stays pure over the reconstructed array.

**1.3 — Schema + migration.** Apply the **Data model changes** above.

**1.4 — Client transport (append-only + edit fork).** `components/chat/chat-surface.tsx:67`

Currently `useChat({ id, messages: initialMessages, transport: new DefaultChatTransport({ api: "/api/chat" }) })` sends the whole array by default.

- Configure the transport to send only the last message and the trigger/fork info. In AI SDK v6 this is `prepareSendMessagesRequest` on `DefaultChatTransport` (verify the exact name in the installed version):
  ```ts
  transport: new DefaultChatTransport({
    api: "/api/chat",
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => ({
      body: { id, trigger, messageId, message: messages[messages.length - 1] },
    }),
  }),
  ```
- For edit/regenerate, surface the **fork ordinal/id** so the server can truncate. `regenerate` already exists (`chat-surface.tsx:67`, used at `:289`). If message editing is added, send the edited message's id; server maps id → ordinal and truncates after the previous turn.
- Destructure `setMessages` from `useChat` for the SSE subscription (Phase 3).

### Phase 2 — Tasks append into their home session

**2.1 — Capture the round transcript.** `lib/scheduler/instruction.ts:79`

`runInstructionRound` currently returns only `InstructionVerdict` (`{ statusUpdate, continue, nextDelaySeconds }`, `instruction.ts:14`) from a `ToolLoopAgent` + `Output.object` call (`instruction.ts:91`). It does **not** currently read `result.steps`.

Change it to also return UI messages for the home session:

```ts
export async function runInstructionRound(args): Promise<{ verdict: InstructionVerdict; messages: ChatUIMessage[] }> {
  const result = await agent.generate({ prompt: buildRoundPrompt(task, payload, previousOutput) });
  if (!result.output?.statusUpdate) throw new Error("Instruction run ended without a usable verdict.");
  const messages = buildRoundMessages(task, payload, result); // see below
  return { verdict: result.output, messages };
}
```

`buildRoundMessages` maps the round into one assistant UI message (`role: 'assistant'`):
- A `text` part containing `result.output.statusUpdate` (the human-readable summary).
- Optionally, tool-call/result parts derived from `result.steps` (if exposed by the SDK) so the transcript shows what the agent did. Keep this in one helper; **snapshot-test it** (see ModelMessage→UIMessage risk).
- `metadata: { origin: "scheduled", scheduledRound: payload.round, taskId: task.id }`.
- **Deterministic id:** `` `task-${task.id}-r${payload.round}` `` so a catch-up re-run is idempotent under `onConflictDoNothing`.

> **AI SDK v6 caveat (verified earlier):** there is no non-streaming ModelMessage→UIMessage converter. You must hand-map. Start minimal (statusUpdate text only) and enrich from `result.steps` if needed.

**2.2 — Home-session resolution + provenance.** `lib/scheduler/tasks.ts`

- Extend `CreateScheduledTaskInput` (`tasks.ts:58`) with `originSessionId?: string`.
- In `createScheduledTask` (`tasks.ts:94`): write `originSessionId` to the row. If **no** `originSessionId`, create a dedicated session for the task (`appendSessionMessages` with `createIfMissing` is for messages; add a small `createTaskSession(taskId, title)` in `lib/chat/sessions.ts` that inserts a session with `origin = 'scheduled_task'`, `task_id = taskId`) and use it as the home.
- Extend the `ScheduledTask` type (`tasks.ts:33`) and `mapTaskRow` with `originSessionId` and a resolved `homeSessionId: string` (`originSessionId ?? dedicatedSessionId`). `getScheduledTaskById` (`tasks.ts:296`) returns it.

**2.3 — Bind the originating session into task creation.** `lib/scheduler/tool-specs.ts` + `app/api/chat/route.ts:14,149`

`schedulerTools` is a **static** module export today; no per-request context flows in. To route a task's output back to the chat that created it, the chat route must tell the tool which session it's in.

- Convert the static export to a factory: `createSchedulerTools(ctx: { originSessionId: string | null })`. The `scheduled_task_create` executor (`tool-specs.ts:155`) passes `originSessionId: ctx.originSessionId` into `createScheduledTask`.
- In the chat route (`route.ts:149`), build `const schedulerTools = createSchedulerTools({ originSessionId: sessionId })` and spread that instead of the static import. (Keep the `TOOL_EXPOSURE_MODE` gating at `route.ts:150`.)

**2.4 — Worker appends the round turn.** `workers/scheduled-tasks.ts:93` (`processInstructionJob`)

- `runInstructionRound` now returns `{ verdict, messages }`; destructure and keep using `verdict` for `markRunCompleted` / `advanceInstructionChain` (worker logic at `:104`, `:118` unchanged).
- After a successful round, append the turn to the home session, **fail-soft** (a transcript error must never stall the chain — the worker already isolates chain mutations at `:117`):
  ```ts
  try {
    await appendSessionMessages(task.homeSessionId, [
      scheduledRunMarker(task, payload.round),   // a short assistant marker turn, metadata.origin='scheduled'
      ...messages,
    ]);
    await notifySessionAppended(task.homeSessionId);   // Phase 3 NOTIFY
  } catch (err) {
    console.error(`Append for task ${task.id} round ${payload.round} failed`, err);
  }
  ```
- For non-instruction (`tool_call`) tasks (`workers/scheduled-tasks.ts:68`), optionally append a compact "ran tool → result" turn to the home session too.
- **Bound recurring chains:** add a max-age or round cap so a recurring task can't append into a human chat indefinitely (Claude Code uses ~7 days). `instruction` tasks already have `maxRounds`; add an equivalent guard for the append path.

### Phase 3 — Live updates + UI

**3.1 — SSE stream endpoint (K2).** New `app/api/sessions/[id]/stream/route.ts`

No streaming endpoint exists under `app/api/sessions/` today (only GET/PATCH/DELETE at `app/api/sessions/[id]/route.ts`).

- `GET` handler returns a `ReadableStream` with `Content-Type: text/event-stream`.
- Open a **dedicated** pg client (not the pool) and `LISTEN chat_append`. On notification, filter for this `sessionId`, query messages with `ordinal > lastSentOrdinal`, and emit them as SSE `data:` events. Send periodic heartbeat comments (`: ping`). On `req.signal` abort: `UNLISTEN` + release the client.
- Worker side: add `notifySessionAppended(sessionId)` issuing `NOTIFY chat_append, '<sessionId>'` (or a small JSON payload `{ sessionId, ordinal }`; keep under the 8 KB NOTIFY limit). The chat route's own appends may also notify, but the open tab already has its own turns locally — **dedupe by message id** on the client.

> **Pooling caveat (K2 risk):** `LISTEN` holds a connection and breaks under transaction-mode poolers. Fine for the current single-user/native-Postgres setup; revisit for serverless/multi-tenant.

**3.2 — Client subscription.** `components/chat/chat-surface.tsx`

- When a `sessionId` is active, open an `EventSource` to `/api/sessions/${sessionId}/stream`. On each pushed message, `setMessages` (from `useChat`) appending only ids not already present (dedupe). Close on unmount / session change. Reconnect with backoff; fall back to `use-smart-poll` (`lib/hooks/use-smart-poll.ts` → `{ data, loading, error, refresh }`) if the stream drops.

**3.3 — Distinct rendering + entry points.**

- Render `metadata.origin === 'scheduled'` turns with a visible marker ("Ran scheduled task · round N") in the chat message renderer (`components/ai-elements/message.tsx` or wherever turns render).
- On the tasks board (`components/scheduled-jobs-board.tsx` / `components/tasks-panel.tsx`), add **"View transcript"** → open the home session via `selectSession(task.homeSessionId)` (`components/app-shell.tsx:169`) or navigate to `/?c=${task.homeSessionId}` (the `?c=` param is handled at `app-shell.tsx:114`).

---

## Risks & gotchas

| | Risk | Mitigation |
|---|------|-----------|
| 🧱 | **Hot-path refactor.** Chat persistence is core. The contract change must preserve title generation (`route.ts:229`), token-usage metadata (`route.ts:193`), and abort/disconnect behavior (`consumeSseStream`, `route.ts:174`). | Keep `onFinish` fail-soft. Test new-turn, regenerate, disconnect, and ephemeral (no `sessionId`) paths. |
| ✂️ | **Edit/regenerate was free under rewrite.** `truncateConversationAfter` makes it explicit; the client must send the fork ordinal/id. | Map id→ordinal server-side; truncate before re-running. |
| 🔁 | **Idempotent appends.** Catch-up (`workers/scheduled-tasks.ts:221` `recoverMissedRuns`) can requeue a round. | Deterministic ids `task-${taskId}-r${round}` + `onConflictDoNothing`. Rounds are sequential per task, so no concurrent append to one session. |
| 🛟 | **Worker append must not stall the chain.** | Wrap append in try/catch (chain mutations are already isolated at `:117`). |
| 🗺️ | **No ModelMessage→UIMessage converter in ai@6.** Worker turns are hand-mapped from `result` and can drift from live rendering. | One `buildRoundMessages` helper; snapshot-test it. |
| 📡 | **K2/SSE holds a DB connection per listener** and breaks under PgBouncer txn-mode. | Dedicated client + UNLISTEN/release on disconnect. Poll fallback. Author preferred poll-first for v1. |
| ⚠️ | **K3/preserve-across-edits can desync agent context** (re-running edited history while keeping old-instruction scheduled turns). | Isolate the re-stitch in `truncateConversationAfter({ preserveScheduled })` so it's trivially revertible to plain truncation. Scheduled output is never lost — it's in `agent_scheduled_task_runs`. |

---

## Acceptance criteria

1. **Joke-into-chat-123:** in an existing chat, "tell me a joke every 10s" creates a task, and each round appends a joke turn **into that same chat**, visible live (SSE) without reload.
2. **Standalone task:** a task created with no originating chat (API / tasks UI) accumulates rounds in its **own dedicated session**, reachable via "View transcript".
3. **No clobber:** sending a user message mid-chain (or right after a worker turn lands) never wipes the worker's appended turns.
4. **Chain control unchanged:** instruction chains still stop on `verdict.continue === false`, at `maxRounds`, and after the consecutive-failure limit (`workers/scheduled-tasks.ts`).
5. **Edit/regenerate (K3):** regenerating an earlier turn forks the conversation but preserves interleaved scheduled turns; transcript stays loadable and ordered.
6. **Fail-soft:** a transcript/append error logs and the schedule continues; an SSE drop falls back to polling.
7. `pnpm db:migrate` applies cleanly; `pnpm build` / typecheck passes; `pnpm worker:scheduled-tasks` runs a manual end-to-end task.

---

## File change checklist

- `db/schema.ts` — sessions `+origin +task_id`; tasks `+origin_session_id`; (no message migration — metadata jsonb).
- `db/drizzle/*` — generated migration (`pnpm db:generate`).
- `lib/token-usage.ts` — extend `ChatMessageMetadata` (`origin?`, `scheduledRound?`, `taskId?`).
- `lib/chat/sessions.ts` — add `appendSessionMessages`, `truncateConversationAfter`, `createTaskSession`; retire `saveChatSession`.
- `app/api/chat/route.ts` — server-authoritative contract; append-only `onFinish`; `createSchedulerTools({ originSessionId })`; regenerate truncation.
- `components/chat/chat-surface.tsx` — `prepareSendMessagesRequest` (last message only); SSE subscription via `setMessages`; fork-ordinal on edit/regenerate.
- `lib/scheduler/instruction.ts` — return `{ verdict, messages }`; add `buildRoundMessages`.
- `lib/scheduler/tasks.ts` — `originSessionId` in input/type/row/map; resolve `homeSessionId`.
- `lib/scheduler/tool-specs.ts` — `schedulerTools` → `createSchedulerTools(ctx)` factory; thread `originSessionId` into `createScheduledTask`.
- `workers/scheduled-tasks.ts` — append round turns fail-soft; `notifySessionAppended`; recurring bound.
- `app/api/sessions/[id]/stream/route.ts` — **new** SSE endpoint (LISTEN/NOTIFY).
- `components/scheduled-jobs-board.tsx` / `components/tasks-panel.tsx` — "View transcript" → `selectSession(homeSessionId)`.
- `components/ai-elements/message.tsx` (or chat renderer) — distinct rendering for `metadata.origin === 'scheduled'`.
