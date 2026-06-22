# Memory Consolidation — Implementation Plan

> Adds a **memory-consolidation layer** on top of the existing self-improvement
> system. The current system already does per-turn review → proposals →
> `agent_memories` / `agent_skills`, soft-archive, provenance, the prompt
> snapshot query, and a pg-boss scheduler. What's missing is the consolidation
> engine: ingest grounded signals → accumulate evidence → score → gate →
> propose durable facts, with a human in the loop the whole way.
>
> The engine's runtime pipeline is named **Ingest → Reflect → Consolidate**.
> The sleep/REM heritage is a metaphor for *why* (separate slow background
> integration from fast in-session writes), not a model we implement.
>
> **This is one feature, built behind flags that are off by default** (§5). It is
> not a phased program to track — the whole thing ships dark, then enabling it is
> a binary decision (on/off), made safely by flipping a few independent switches
> (§8).

> **How to use this plan.** Build it in the PR sequence in §8; each PR has a
> Definition of Done you can run. **Exact Drizzle columns, enum spellings, the
> `AdmissionMetadata` shape, and tool schemas live in Appendix A — copy them
> verbatim; do not invent column types, enum strings, or signatures.** When in
> doubt, read the cited file:line before writing code.

---

## 0. Fixed decisions (do not relitigate)

1. **Storage = Postgres/Drizzle.** Extend `db/schema.ts` in the existing style
   (text + `CHECK` enums, partial indexes, soft-delete via `deleted_at`,
   `timestamptz`). Generate with `pnpm db:generate`, apply with
   `pnpm db:migrate`. **Add every new table to `tablesFilter` in
   `drizzle.config.ts`** or drizzle-kit will not manage it.
2. **Many bounded writers, one admission boundary.** Consolidation is a
   *proposer* into `agent_review_proposals` — it is **not** a privileged sole
   writer. This is the governance model the app already uses; we extend it.
3. **The provenance firewall is a physical table, not a `WHERE` clause.**
   Evidence is built only from a dedicated `agent_grounded_observations` table
   that is populated *exclusively* from user-authored content. Evidence/recall
   rows reference grounded-observation ids. Derivative content (assistant text,
   review/consolidated memories) can never enter the evidence tier.
4. **Fix the missing two-state snapshot.** Memory is currently re-queried per
   POST (`route.ts` → `inject.ts`). Add a session-start materialized snapshot so
   the in-session prompt is frozen; durable writes affect the *next* session.
5. **All scores are stored as integer basis points (0..10000)**, never floats —
   matching the repo convention for `confidence` (`db/schema.ts:230`, comment:
   "avoids provider-specific float quirks"). `0.8307 → 8307`; UI divides by 10000.
   Pure scoring tests may assert decimals; persisted/compared values are integers.
6. **Feature flag off by default; dry-run first.** Nothing auto-applies until
   explicitly enabled, and even then only a narrow, low-risk class.

---

## 1. DB migrations

All changes go in `db/schema.ts`, then `pnpm db:generate`. **Historical raw SQL
in `db/migrations/` is frozen — do not add files there** (see its README); the
source of truth is `db/schema.ts` → `db/drizzle/`. **Exact column definitions for
everything in this section are in Appendix A — use them verbatim.**

### 1.1 Extend existing tables

**`agent_memories`** (exact columns: Appendix A.2)
- `source` CHECK enum gains **`consolidated`** → `user | review | curated | consolidated`.
- `claim_hash text` — normalized-content hash for dedupe/idempotency.
- `is_protected boolean not null default false` — human "pin"; consolidation and
  curator must never archive/edit a protected row.
- `protected_at timestamptz`, `protected_by text` — provenance of the pin.
- **Partial UNIQUE index** `agent_memories_claim_hash_uniq` on
  `(agent_id, kind, claim_hash) WHERE deleted_at IS NULL AND claim_hash IS NOT NULL`
  — this index (not app logic) is what prevents duplicate durable facts and makes
  auto-apply races safe (§4.4).
- The existing `agent_memories_prompt_idx` (the prompt-snapshot query) is unchanged.

**`agent_review_proposals`** (exact columns: Appendix A.3)
- `proposer_origin` text CHECK `manual | turn_review | consolidation | curator`,
  `not null default 'turn_review'` (matches current behavior on backfill).
- `admission_policy` text CHECK `human_review | auto_apply_low_risk | dry_run_only`,
  `not null default 'human_review'`.
- `admission_metadata jsonb` typed as `AdmissionMetadata` (Appendix A.1) — score
  breakdown, gate results, evidence ids, candidate id. The review UI renders this.

**Code changes forced by the above** (do exactly this):
- `lib/self-improvement/validation.ts:10` — `MEMORY_SOURCES` becomes
  `["user", "review", "curated", "consolidated"] as const`.
- `lib/self-improvement/apply.ts` — in the `memory_create` branch of the
  advisory-lock apply path (~`apply.ts:72–78`, currently hard-coding
  `source: "review"`), derive the source from the proposal and **guard the
  privileged source**:
  ```ts
  const memorySource =
    proposal.proposerOrigin === "consolidation"
      ? parseMemorySource(payload.source, "consolidated")
      : parseMemorySource(payload.source, "review");

  // Only consolidation proposals may mint a `consolidated` memory.
  if (memorySource === "consolidated" && proposal.proposerOrigin !== "consolidation") {
    throw new SelfImprovementInputError(
      "Only consolidation proposals may create consolidated memories.",
    );
  }
  await createMemory({ /* ... */ source: memorySource }, db);
  ```
- `lib/self-improvement/proposals.ts` — add `proposerOrigin`, `admissionPolicy`,
  `admissionMetadata` to `ReviewProposal`, `CreateReviewProposalInput`,
  `createReviewProposal`, the list filters, and `mapProposalRow`
  (`proposals.ts:23`). Existing callers pass nothing → defaults apply.

### 1.2 New tables

All new tables are `agent_`-prefixed, partial-indexed, soft-deleted where rows
are user-visible, and **added to `drizzle.config.ts` `tablesFilter`** (see
checklist in Appendix A.10). Exact columns/types: Appendix A.4–A.9.

- **`agent_grounded_observations`** — the firewall. One row per user-authored
  unit. **Source shape is enforced by a CHECK** (Appendix A.4), not by convention:
  a `chat_user` row must have `session_id` + `source_message_id` and no
  `source_memory_id`; a `memory_user` row must have `source_memory_id` and
  neither chat field. `source_message_id` is **`text` with no FK** —
  `agent_chat_messages` has a composite PK `(session_id, id)` (`db/schema.ts:193`),
  so a single-column FK is impossible. **Dedupe by source identity, not content:**
  unique on `(agent_id, session_id, source_message_id)` for chat and
  `(agent_id, source_memory_id)` for memory — **never** dedupe by `content_hash`
  (repeated user statements are real evidence and must each count).

- **`agent_recall_signals`** — evidence accumulation (machine state, never in
  prompt). Holds `grounded_observation_ids jsonb` (id list into the table above),
  `recall_count`, `unique_query_count`, `query_hashes`/`recall_days`/`concept_tags`
  jsonb, `total_score_bps`/`max_score_bps` **(basis points, §0.5)**, timestamps,
  `claim_hash`, `promoted_at`, `promoted_proposal_id`.

- **`agent_phase_signals`** — bounded phase boosts. `light_hits`, `rem_hits`,
  `last_light_at`, `last_rem_at`. Phase hits give a small capped boost only (§4.2);
  they can **never** satisfy the count/diversity gates alone.

- **`agent_ingestion_checkpoints`** — incremental watermark. **Tuple checkpoints,
  not a single id** (chat-message id is not globally unique). Stores
  `last_chat_message_created_at` + `last_chat_session_id` + `last_chat_message_id`,
  and `last_memory_created_at` + `last_memory_id` (Appendix A.6). Scans order by
  `(created_at, session_id, id)` for chat and `(created_at, id)` for memories.

- **`agent_memory_snapshots`** — the two-state fix. `session_id` **UNIQUE** (one
  snapshot per session). `rendered_block text`, `memory_ids jsonb`, `created_at`.
  The chat route renders from `rendered_block` (§3c).

- **`agent_consolidation_settings`** — per-agent operator config (mirrors env
  defaults, overridable in UI). Thresholds stored as integers/basis points
  (`min_score_bps default 8000`, `min_recall_count default 3`,
  `min_unique_queries default 3`, `max_age_days default 30`, `weights jsonb`).

- **`agent_consolidation_runs`** — one row per sweep. `status
  (running|completed|failed)`, `trigger (scheduled|manual)`, counters, `error`.

- **`agent_consolidation_candidates`** — per-run scored claims (dry-run preview +
  explain-why). `score_bps`, `gate_results jsonb`, `passed boolean`, `proposal_id`.

- **`agent_memory_events`** — **the timeline / "see the evolution" feed.**
  Append-only, human-readable, **never read back into evidence.** Columns:
  `event_type` (Appendix A.1 enum), `memory_id`, `proposal_id`, `run_id`, `origin`,
  `summary text`, `detail jsonb` (shape in Appendix A.1). **Do not** log
  `memory_search` usage here (usage ≠ evolution).

### 1.3 FK / delete semantics

- `agent_memories.review_proposal_id` stays `ON DELETE SET NULL`. Soft-archive
  (`status='archived'`) is the compaction mechanism — never hard-delete a memory
  another row references.
- `agent_recall_signals.grounded_observation_ids` are an id list, not hard FKs, so
  observation pruning never cascades into evidence. Pruning is explicit (§8), not
  `ON DELETE`.

---

## 2. New modules

New code lives under **`lib/consolidation/`**, reusing `lib/self-improvement`
(proposals, apply, validation) and `lib/scheduler` (pg-boss) patterns rather
than reinventing them.

| Module | Responsibility | Key exports |
|--------|----------------|-------------|
| `config.ts` | Flags + scoring defaults; merges env with `agent_consolidation_settings`. | `getConsolidationConfig(agentId)` |
| `normalize.ts` | Claim normalization → `claim_key` / `claim_hash`; concept tagging. | `normalizeClaim(text)`, `claimHash(text)` |
| `observations.ts` | The firewall writer/reader. **Only** path that inserts grounded observations. | `ingestUserTurn(...)`, `listGroundedObservations(agentId, since)` |
| `signals.ts` | Update recall + phase signals from observations; manage checkpoints. | `accumulateRecall(...)`, `recordPhaseHit(...)` |
| `scoring.ts` | Pure, deterministic score + gate predicates (golden-tested). Returns basis points. | `scoreClaim(signal, cfg)`, `passesGates(signal, scoreBps, cfg)` |
| `run.ts` | Orchestrate a sweep: scan → accumulate → score → gate → write candidates. | `runConsolidation(agentId, {trigger})` |
| `propose.ts` | Turn passed candidates into `agent_review_proposals` (origin=`consolidation`, admission_metadata=score/gates/evidence). | `proposeCandidate(candidate)` |
| `snapshots.ts` | Materialize the session-start memory snapshot (the two-state fix). | `materializeSnapshot(agentId, sessionId)`, `getSnapshot(sessionId)` |
| `explain.ts` | Human-readable score breakdown + gate reasons for the UI. | `explainCandidate(candidateId)` |
| `events.ts` | Append to `agent_memory_events` from every writer. | `recordMemoryEvent(...)` |
| `jobs.ts` | pg-boss queue + worker registration for the sweep. | `CONSOLIDATION_QUEUE_NAME`, `enqueueConsolidation(...)`, `registerConsolidationWorker(boss)` |

**Extend (don't fork) existing files:**
- `lib/self-improvement/apply.ts` — generalize `source` (§1.1); fire
  `recordMemoryEvent` for every applied proposal.
- `lib/self-improvement/proposals.ts` — origin/policy fields + list filters (§1.1).
- `lib/self-improvement/inject.ts` — read from the snapshot, not the live query (§3c).
- `lib/self-improvement/memories.ts` — add `searchMemories(...)` for `memory_search` (§10).

---

## 3. Wiring

**(a) Grounded-observation ingestion — role-gated, not caller-trusted.**
`appendSessionMessages` (`lib/chat/sessions.ts:143`) is called for **assistant**
messages too (`route.ts:337`) and by the **scheduled-task worker**
(`workers/scheduled-tasks.ts:86,150`). So the ingestion hook must **never** trust
the caller's intent. Rules:
- `observations.ingestUserTurn(...)` ingests **only** parts where
  `message.role === "user"`, and **only text parts** — assistant/system/tool
  content is dropped.
- The manual memory route currently forwards a client-supplied `source`
  (`app/api/memories/route.ts:31`). **`POST /api/memories` must ignore
  `body.source` and always write `source: "user"`.** Internal proposal apply is
  the only path allowed to set non-user sources.
- `createMemory` ingests a `memory_user` observation **only when the inserted
  row's final source is exactly `user`**.
- Incremental via `agent_ingestion_checkpoints` (tuple watermark, §1.2).

**(b) The consolidation sweep = its own internal pg-boss job.** In
`lib/scheduler/boss.ts` (queue creation is centralized in `startAndPrepare`,
`boss.ts:55`):
```ts
export const CONSOLIDATION_QUEUE_NAME = "agent-consolidation";
export const CONSOLIDATION_DLQ_NAME = "agent-consolidation-dlq";
// singletonKey is a SEND option, not a createQueue option:
export function consolidationSendOptions(agentId: string) {
  return { singletonKey: agentId };
}
```
Create the **DLQ first**, then the queue with `{ deadLetter: CONSOLIDATION_DLQ_NAME,
expireInSeconds, policy: "stately", retryLimit }`, mirroring the existing queues
(`boss.ts:66–77`). It is **not** the user-facing `agent-task-run` queue and never
appears as a user scheduled task. Add a new `workers/consolidation.ts`, add
`"worker:consolidation": "tsx workers/consolidation.ts"` to `package.json`
scripts, and add it to the `dev` `concurrently` block (it currently runs 3
processes — app, worker:scheduled-tasks, worker:turn-review; add the name, color,
and command). Schedule via pg-boss cron when the flag is on.

**(c) Session-start snapshot — materialize once, not per POST.** Today the route
re-queries memory every POST (`route.ts:252`), and `buildRunMessages` doesn't say
whether the session is new. Have it return that:
```ts
type BuiltRunMessages = { messages: ChatUIMessage[]; isSessionStart: boolean };
// isSessionStart = priorHistory.length === 0 (before appending the incoming msg)
```
In the route, call `snapshots.materializeSnapshot(DEFAULT_AGENT_ID, sessionId)`
**only when `sessionId && isSessionStart`**; otherwise read the existing snapshot.
`inject.ts` renders from `getSnapshot(sessionId)`. Result: the in-session
declarative-memory block is frozen for the session. (`agent_memory_snapshots.session_id`
is UNIQUE, §1.2.)

**(d) Proposals flow through the existing apply path.** `propose.ts` writes a
normal `agent_review_proposals` row. Approval — manual or auto — calls the
existing `applyReviewProposal(id)` (with its `pg_advisory_xact_lock`), so
consolidation reuses the same concurrency-safe choke point. On apply, the memory
lands with `source='consolidated'`.

**(e) Auto-apply vs manual.** Default: every consolidation proposal is
`admission_policy='human_review'`. Only the narrow auto-apply class (§4.4) may be
`auto_apply_low_risk`, and only when both the global flag and per-agent
`auto_apply_enabled` are true. Everything else waits in the inbox.

---

## 4. Firewall + scoring + gates + auto-apply

### 4.1 Firewall (the load-bearing invariant)

```
user chat turn ─┐
                ├─► agent_grounded_observations ─► recall/phase signals ─► score
source='user'  ─┘        (physical table)
memory

assistant text          ─╳─ never ingested (role gate, §3a)
review/curated/          ─╳─ never an observation, never evidence
consolidated memory
```

Evidence rows reference `grounded_observation_ids`. Because observations are a
physically separate table written by one role-gated module, "score your own
output" is structurally impossible — not merely discouraged by a `WHERE` clause.
A negative test (§6) asserts assistant/derivative content never produces an
observation.

### 4.2 Scoring (ported shipped defaults — compute in basis points)

```
score =  0.30·relevance
       + 0.24·frequency
       + 0.15·diversity
       + 0.15·recency        (exp half-life 14 days)
       + 0.10·consistency
       + 0.06·concept
       + phase_boost          (light ≤ 0.06, rem ≤ 0.09, capped)
```

Deterministic and pure in `scoring.ts`. Internally compute in basis points and
return an integer 0..10000. **Golden regression vectors: 0.8307 and 0.4702** —
the *full input objects* for these live in `lib/consolidation/__fixtures__/scoring-vectors.ts`
(§6); tests assert against them, never against invented inputs.

### 4.3 Gates (ALL must pass to propose)

- `score_bps ≥ 8000` (`min_score_bps`)
- `recall_count ≥ 3` (`min_recall_count`)
- `unique_query_count ≥ 3` (`min_unique_queries`)
- evidence age `≤ 30 days` (`max_age_days`)
- **at least one grounded observation** backs the claim (phase hits alone can
  never satisfy the gate)

### 4.4 Auto-apply predicate (only when enabled) + race safety

Auto-apply iff **all**: global flag on **AND** per-agent `auto_apply_enabled`
**AND** `admission_policy='auto_apply_low_risk'` **AND** `kind='memory_create'`
(never edit/archive) **AND** `score_bps ≥ 9000` **AND** no existing memory with the
same `claim_hash` **AND** the target is not `is_protected`. Anything failing any
clause routes to `human_review`.

**Race safety:** the "no existing claim_hash" check is **not** trusted in app code
alone. Auto-apply still goes through `applyReviewProposal(id)` (advisory lock) and
relies on the `agent_memories_claim_hash_uniq` index (§1.1). A duplicate-key on
insert is caught and treated as **already-applied / no-op**, then writes a
`agent_memory_events` row with `detail.reason = "duplicate_claim_hash"`. This keeps
auto-apply additive-only: it never mutates or removes, and every apply is logged.

---

## 5. Config / flags — the on/off switches

The feature is binary. These flags are the yes/no switches; all are off/safe by
default. Env defaults live in `lib/consolidation/config.ts`; a per-agent
`agent_consolidation_settings` row wins when present (mirrors the existing
`lib/self-improvement/config.ts` split). **Add all of these to `.env.example`**
with these safe defaults so local setup and verification don't miss them.

- `MEMORY_CONSOLIDATION_ENABLED=false` — **master switch.** Off = nothing runs.
- `MEMORY_CONSOLIDATION_DRY_RUN=true` — compute + candidates, **no proposals**.
- `MEMORY_CONSOLIDATION_AUTO_APPLY=false` — gates the narrow auto-apply class.
- `MEMORY_CONSOLIDATION_CRON` — sweep schedule (e.g. nightly).
- `MEMORY_CONSOLIDATION_VERBOSE=false` — debug logging.
- `MEMORY_SEARCH_ENABLED=false` — exposes the agent-facing `memory_search` tool
  (§10). Independent of the consolidation flags above.

---

## 6. Tests

No `test` script exists yet. Add Vitest:
```bash
pnpm add -D vitest
```
and `"test": "vitest run"` in `package.json`. Then:

- **Unit / golden vectors** — `lib/consolidation/scoring.test.ts`: import the
  fixtures from `lib/consolidation/__fixtures__/scoring-vectors.ts` (the full input
  objects) and assert `scoreClaim` returns the golden values (0.8307 → 8307,
  0.4702 → 4702) and that gate predicates flip exactly at thresholds. **Tests must
  not invent inputs.**
- **Firewall negatives** — `firewall.test.ts`: feeding assistant text, a
  `source='review'` memory, or a `source='consolidated'` memory through ingestion
  produces **zero** `agent_grounded_observations` and zero evidence rows; a
  `memory_search` call produces zero observations. **The most important test.**
- **Apply/metadata** — `apply`/`proposals`/`validation` tests: a `consolidation`
  proposal applies a `source='consolidated'` memory; a non-consolidation proposal
  attempting `source='consolidated'` throws; `POST /api/memories` ignores
  `body.source`.
- **Integration** — `pipeline.test.ts`: seed user turns → ingest → accumulate →
  score → gate → propose → `applyReviewProposal` → assert the consolidated memory
  exists; second run with the same `claim_hash` is a no-op (unique index) and logs
  `duplicate_claim_hash`; a `agent_memory_events` row was written.
- **Snapshot** — the in-session block is frozen across POSTs and refreshes on a
  new session (`isSessionStart`).

---

## 7. Observability / operator affordances

- `agent_consolidation_runs` is the run log (scanned/evaluated/passed/proposed,
  duration, errors).
- `agent_consolidation_candidates` + `explain.ts` back the dry-run preview and
  the per-item "why did/didn't this promote" surface.
- `agent_memory_events` is the human-facing timeline (§9); its `detail` shape is
  in Appendix A.1. **Never** log `memory_search` usage into it.
- `VERBOSE` logging in the worker; counts surfaced in the `/consolidation` UI.

---

## 8. Build sequence, enable order & Definition of Done

### 8.1 Build order (one PR each, each independently shippable)

The **minimal first PR has zero runtime behavior change** — note that "the corpus
quietly fills" is *runtime* behavior, so ingestion is **not** in PR1.

- **PR1 — Schema + types only.** `db/schema.ts` additions (Appendix A),
  `drizzle.config.ts` `tablesFilter`, generated `db/drizzle/<n>_*.sql`, config
  parser defaults, `.env.example`. No route hooks, no worker, no UI, no
  ingestion, no `memory_search`.
- **PR2 — Apply + proposal metadata + event logging.** `validation.ts`,
  `apply.ts` (source guard), `proposals.ts` (origin/policy/metadata),
  `events.ts`. No new writers yet.
- **PR3 — Session-start snapshot.** `snapshots.ts`, `buildRunMessages`
  `isSessionStart`, `inject.ts` reads snapshot.
- **PR4 — Observation ingestion + backfill.** `observations.ts` (role-gated),
  the `POST /api/memories` `source` fix, the backfill script (8.3).
- **PR5 — Scoring + dry-run worker.** `normalize.ts`, `signals.ts`, `scoring.ts`
  (+ fixtures/tests), `run.ts`, `jobs.ts`, `workers/consolidation.ts`, queue
  creation, `dev` script. Produces runs/candidates only (no proposals).
- **PR6 — UI (split into 3).** (a) `/proposals` origin/policy badges + metadata
  rendering; (b) new `/consolidation` page + its API routes; (c) `/memories`
  timeline tab. (See §9.)
- **PR7 — `memory_search` tool.** `searchMemories`, `memory-tools.ts`, gated
  route wiring (§10).
- **PR8 — Enable.** Flip flags (8.2). No code.

### 8.2 Enable order (flags, §5) — never enable a riskier mode before a safer one

1. **Ship dark** (`ENABLED=false`). Schema + plumbing present, nothing runs.
2. **Backfill** grounded observations (8.3), then set checkpoints to current max.
3. **Dry-run** (`ENABLED=true`, `DRY_RUN=true`): candidates appear in
   `/consolidation`, nothing is proposed. Tune weights/gates here.
4. **Proposals** (`DRY_RUN=false`): consolidation proposals reach the inbox for
   human approval. Still nothing auto-applies.
5. **(Optional) auto-approve** (`AUTO_APPLY=true`): the narrow class (§4.4)
   applies on its own; everything else still waits.

**Kill switch:** `MEMORY_CONSOLIDATION_ENABLED=false` stops sweeps;
`MEMORY_CONSOLIDATION_AUTO_APPLY=false` forces everything back to the inbox
without losing in-flight candidates.

### 8.3 Backfill script

`scripts/backfill-grounded-observations.ts` — imports `@/lib/scheduler/load-env`,
supports `--dry-run`, reads **only** user-role chat messages and `source='user'`
memories (never assistant/system/tool), inserts via the source unique indexes with
`onConflictDoNothing`, and orders by the tuple keys in §1.2.

### 8.4 Definition of Done (run these; all must pass)

- **PR1:** `pnpm db:generate` produces exactly one new `db/drizzle` migration +
  meta snapshot; `pnpm typecheck`; `pnpm lint`. With flags absent, chat /
  proposals / memories behavior is unchanged.
- **PR2:** `pnpm test apply proposals validation`; `pnpm typecheck`.
- **PR3:** `pnpm test snapshots`; `pnpm build`.
- **PR4:** `pnpm test firewall`; run backfill with `--dry-run` and confirm
  assistant/system rows scanned = 0.
- **PR5:** `pnpm test scoring pipeline`; a smoke run
  (`pnpm exec tsx scripts/smoke-consolidation.ts`) in dry-run creates a run +
  candidates and **zero** proposals.
- **PR6 / PR7:** `pnpm typecheck`; `pnpm lint`; `pnpm build`.

---

## 9. UI / UX — the human sees the evolution and stays in the loop

Grounded in the existing pages (`app/memories`, `app/proposals`, `app/skills`,
`app/tasks` — simple client pages with inline `fetch`, e.g. `memories/page.tsx:42`,
`proposals/page.tsx:44`) and components (`components/ui`, `components/ai-elements`,
`app-sidebar.tsx`). **Extend these; don't reinvent.** New nav item:
**Consolidation**. Ship UI in the three slices in §8.1 PR6.

> **Snapshot caveat (show as an inline notice on edit/CRUD surfaces):** edits
> apply to durable rows and take effect in the **next** session's snapshot — they
> do not mutate the current live chat's frozen prompt. Optimistic UI updates the
> list immediately; the "active now" badge reflects the current snapshot.

### 9.1 See the evolution — `/memories` timeline tab + activity feed

- **Route/page:** extend `app/memories/page.tsx` with a **Timeline** tab.
- **Components:** reuse table/card/badge from `components/ui`; add `MemoryTimeline`
  (groups `agent_memory_events` by day), `OriginBadge`
  (`user` / `review` / `consolidated` color-coded), `ScoreBreakdown`.
- **Reads:** `GET /api/memory-events?agentId=…`. For consolidated entries,
  expandable `admission_metadata` → score + gate breakdown.
- **"Dream diary" feed:** a `RunFeed` panel listing `agent_consolidation_runs`.
  Human-readable only — never re-enters evidence.

### 9.2 Human-in-the-loop review — `/proposals` inbox

- **Route/page:** extend `app/proposals/page.tsx` into a pending inbox.
- **Components:** `ProposalCard` (kind, origin badge, rationale), `ProposalDiff`,
  `EvidenceDrawer` + `ScoreBreakdown` (consolidation proposals show backing
  observations + gate results), `BatchActionBar`.
- **Actions / endpoints (use the REAL paths):**
  - Approve → **`POST /api/proposals/:id/approve`** (this is the existing apply
    path; there is no `/apply` route).
  - Reject → `POST /api/proposals/:id/reject`.
  - **Edit-then-approve is deferred** unless this PR also adds
    `PATCH /api/proposals/:id`. Ship approve/reject + edit-after-apply first.
  - Batch approve/reject over a filtered set.
- **Auto vs wait:** badge — `Awaiting review` vs `Auto-applied`. Filters by
  `proposer_origin` and `admission_policy`.

### 9.3 Manual CRUD — `/memories` and `/skills` (use the REAL paths)

- **Add:** "New memory" → `POST /api/memories`. The route forces `source='user'`,
  `status='approved'` (§3a) — **the client cannot set `source`.** It also becomes
  a grounded observation (legitimate evidence). Skills via existing skills API.
- **Edit:** `PATCH /api/memories/:id`. **Editing a `consolidated` memory flips
  ownership** — set `source='user'` so the human's correction is ground truth and
  consolidation won't re-archive/"correct" it. Records an `edited` event.
- **Remove:** archive → **`DELETE /api/memories/:id`** (soft archive; there is no
  `/archive` route).
- **Pin / protect:** **`PATCH /api/memories/:id` with `{ isProtected: boolean }`**
  (no `/protect` route). Protected rows are excluded from consolidation/curator
  archive + edit; show a lock badge.

### 9.4 Controls — `/consolidation` (new page)

- **Route/page:** new `app/consolidation/page.tsx`; add to `app-sidebar.tsx`.
- **Components:** `ConsolidationStatus`, `ConsolidationControls` (toggle enabled /
  dry-run / auto-apply, edit weights+gates → `agent_consolidation_settings`),
  `RunNowButton`, `CandidateTable`, `EvidenceDrawer` + `ScoreBreakdown`.
- **New endpoints:** `GET /api/consolidation/status`, `GET …/runs`,
  `GET …/candidates?runId=…`, `PUT …/settings`, `POST …/run` →
  `enqueueConsolidation(agentId, {trigger:'manual'})`.
- **Explain-why** is first-class: any candidate (even ones that *didn't* promote)
  shows score components, gate-by-gate pass/fail, and the backing observations.

---

## 10. Agent-facing memory retrieval (`memory_search`)

Today memory is **pushed**: `loadMemoryBlock` (`lib/self-improvement/inject.ts`)
injects up to 40 approved memories into the `<declarative_memory>` block every
session, and the agent has no way to reach anything beyond that. Skills, by
contrast, are **pulled** — `skill_search` / `skill_get_content`
(`lib/skills/tool-specs.ts`). As consolidation grows the durable store, the flat
40-row push silently drops the tail. This section gives memory the same pull
affordance.

### 10.1 The push / pull split

- **Core (pushed):** a small always-on block — pinned/protected rows
  (`is_protected`) plus the top N by confidence/recency (default ~12). Replaces
  the flat 40-cap in `loadMemoryBlock`.
- **Tail (pulled):** everything else is reachable via the tool. Nothing is
  silently dropped.
- **Fallback:** if `MEMORY_SEARCH_ENABLED` is off, keep today's behavior (push up
  to 40, no tool).

### 10.2 The tool (exact schema)

Mirror the skills tool pattern (`buildSpecToolSet`). One tool is enough — memories
are short (≤2000 chars), so search returns content inline (no separate `_get`):

```ts
// input
{ query: string; kind?: "preference" | "fact" | "correction" | "persona"; limit?: number }
// limit default 10, max 20

// success
{ success: true; query: string; count: number;
  memories: Array<{ id: string; kind: string; content: string; confidence: number; source: string }> }
// failure (flag off / unavailable)
{ success: false; error: SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE }
```

Query **only** `status='approved' AND deleted_at IS NULL`, optional `kind`,
ILIKE-escaped `%query%`. **No inserts, no events, no checkpoint updates.** Add
`memoryToolSpecs`, `memoryToolHandlers`, and
`memoryTools = buildSpecToolSet(memoryToolSpecs, memoryToolHandlers)` in
`lib/self-improvement/memory-tools.ts`, backed by `searchMemories(agentId, query, opts)`
in `lib/self-improvement/memories.ts`. **Lexical first** (`to_tsvector`/`ILIKE`,
optional `pg_trgm`/FTS GIN index); pgvector recall is the deferred upgrade (§11.5)
behind the same signature.

### 10.3 Wiring (gating done right)

**Do NOT add `memory_search` to the shared `toolRegistry` providers**
(`lib/tools/registry.ts:99`) — that registry feeds the deferred tool-search path
and would expose the tool even when the flag is off. Instead expose it **only as a
direct tool** in the route's `tools` object, gated by `MEMORY_SEARCH_ENABLED`, the
same way `skillTools` is conditionally spread (`route.ts:266`). Load it at the same
`Promise.all` site (`route.ts:252`). Extend `instructions` so the model knows the
pushed block is only the core and it can `memory_search` for anything not shown —
the way `SKILLS_PROMPT` frames the catalog as searchable.

### 10.4 Firewall (read-only, no loop-back)

`memory_search` is **read-only**: it writes nothing, and — by the §4 firewall — the
assistant turn that quotes a retrieved memory is itself derivative content that can
never become a grounded observation. So retrieval cannot reintroduce the
amplification loop, even when the model restates a `consolidated` memory. A
negative test (§11.1, §6) asserts a `memory_search` call produces zero
`agent_grounded_observations`.

### 10.5 Config / tests / UI

- **Flag:** `MEMORY_SEARCH_ENABLED=false` (§5) — independent of consolidation.
- **Tests:** returns only approved/non-deleted rows, respects `kind`/`limit`,
  ranks by relevance; plus the firewall negative above.
- **UI:** optional, lightweight — a retrieval count in `/consolidation`
  observability. Keep retrievals **out** of the `agent_memory_events` timeline
  (usage ≠ evolution).

---

## 11. Risks / open questions (top 5, each with a default)

1. **Provenance collapse (the #1 failure mode).** If derivative content ever
   becomes evidence, the system manufactures certainty. **Default:** the physical
   `agent_grounded_observations` table + the role-gated single ingestion writer
   (§3a) + the `POST /api/memories` source fix + the firewall negative test (§6)
   are non-negotiable. Never relax to a `WHERE` clause.
2. **Auto-apply silently becomes a sole writer.** **Default:** off by default,
   additive-only `memory_create` at `score_bps ≥ 9000`, never edit/archive/touch
   protected rows, enforced by the unique index, every apply logged (§4.4).
3. **Inbox flooding** from a high-volume statistical pass. **Default:** strict
   gates (§4.3) + per-`claim_hash` dedupe + start in dry-run to calibrate.
4. **Snapshot staleness confusing users.** Editing memory mid-session doesn't
   change the live chat. **Default:** the inline snapshot-caveat notice + an
   "active now vs next session" badge; optimistic list updates.
5. **Recall matching quality** with only lexical search. **Default:** ship lexical
   first; treat pgvector semantic recall as a deferred enhancement behind its own
   flag once the pipeline is proven and the firewall holds.

---

## Appendix A — Concrete schema & types (paste-ready)

Drizzle in this repo uses `text(...).$type<...>()` + `check(...)` for enums,
`integer(...)` for bounded numbers (no floats), `timestamp(..., { withTimezone: true })`,
and partial indexes via `.where(sql\`...\`)`. Follow `db/schema.ts:22+` style.

### A.1 Shared TypeScript types

```ts
export type MemorySource = "user" | "review" | "curated" | "consolidated";
export type ReviewProposalOrigin = "manual" | "turn_review" | "consolidation" | "curator";
export type AdmissionPolicy = "human_review" | "auto_apply_low_risk" | "dry_run_only";
export type GroundedObservationOrigin = "chat_user" | "memory_user";
export type ConsolidationRunStatus = "running" | "completed" | "failed";
export type ConsolidationTrigger = "scheduled" | "manual";
export type MemoryEventType =
  | "created" | "edited" | "archived" | "protected" | "unprotected"
  | "proposed" | "applied" | "rejected" | "consolidation_run";
export type MemoryEventOrigin = "user" | "review" | "consolidation" | "curator";

export type AdmissionMetadata = {
  version: 1;
  origin: ReviewProposalOrigin;
  candidateId?: string;
  claimKey?: string;
  claimHash?: string;
  scoreBps?: number;                 // 0..10000
  score?: {
    relevanceBps: number; frequencyBps: number; diversityBps: number;
    recencyBps: number; consistencyBps: number; conceptBps: number;
    phaseBoostBps: number; totalBps: number;
  };
  gates?: {
    minScore: { passed: boolean; actualBps: number; thresholdBps: number };
    recallCount: { passed: boolean; actual: number; threshold: number };
    uniqueQueries: { passed: boolean; actual: number; threshold: number };
    maxAgeDays: { passed: boolean; actual: number; threshold: number };
    groundedEvidence: { passed: boolean; actual: number; threshold: 1 };
  };
  groundedObservationIds?: string[];
  autoApply?: { eligible: boolean; reasons: string[] };
  dryRun?: boolean;
};

// agent_memory_events.detail
export type MemoryEventDetail = {
  version: 1;
  before?: unknown;
  after?: unknown;
  admissionMetadata?: AdmissionMetadata;
  reason?: string;                   // e.g. "duplicate_claim_hash"
};
```

### A.2 `agent_memories` additions
```ts
claimHash: text("claim_hash"),
isProtected: boolean("is_protected").notNull().default(false),
protectedAt: timestamp("protected_at", { withTimezone: true }),
protectedBy: text("protected_by"),
// source CHECK becomes ('user','review','curated','consolidated')
// + partial unique index:
uniqueIndex("agent_memories_claim_hash_uniq")
  .on(t.agentId, t.kind, t.claimHash)
  .where(sql`${t.deletedAt} is null and ${t.claimHash} is not null`)
```

### A.3 `agent_review_proposals` additions
```ts
proposerOrigin: text("proposer_origin").$type<ReviewProposalOrigin>().notNull().default("turn_review"),
admissionPolicy: text("admission_policy").$type<AdmissionPolicy>().notNull().default("human_review"),
admissionMetadata: jsonb("admission_metadata").$type<AdmissionMetadata>(),
// + checks for the exact enum spellings in A.1
```

### A.4 `agent_grounded_observations`
```
id              uuid pk defaultRandom
agentId         uuid notNull default <singleton agent id>
sessionId       uuid nullable           -- chat provenance; NO FK (composite msg PK)
originKind      text notNull $type<GroundedObservationOrigin> CHECK ('chat_user','memory_user')
sourceMessageId text nullable           -- agent_chat_messages.id is text, not unique alone
sourceMemoryId  uuid nullable references agent_memories(id)
content         text notNull CHECK char_length 1..2000
contentHash     text notNull
createdAt       timestamptz notNull defaultNow
deletedAt       timestamptz nullable

CHECK agent_grounded_observations_source_shape:
  (origin_kind='chat_user'  AND session_id IS NOT NULL AND source_message_id IS NOT NULL AND source_memory_id IS NULL)
  OR
  (origin_kind='memory_user' AND source_memory_id IS NOT NULL AND source_message_id IS NULL)

UNIQUE (agent_id, session_id, source_message_id) WHERE origin_kind='chat_user'
UNIQUE (agent_id, source_memory_id)              WHERE origin_kind='memory_user'
INDEX  (agent_id, created_at)                    WHERE deleted_at IS NULL
```

### A.5 `agent_recall_signals` (scores = basis points)
```
... claimHash text, snippet text,
groundedObservationIds jsonb, recallCount int, uniqueQueryCount int,
queryHashes jsonb, recallDays jsonb, conceptTags jsonb,
totalScoreBps int, maxScoreBps int, firstRecalledAt/lastRecalledAt timestamptz,
promotedAt timestamptz, promotedProposalId uuid
CHECK score_bps between 0 and 10000;  CHECK counts >= 0
```

### A.6 `agent_ingestion_checkpoints` (tuple watermark)
```ts
agentId: uuid("agent_id").primaryKey().default("<singleton>"),
lastChatMessageCreatedAt: timestamp("last_chat_message_created_at", { withTimezone: true }),
lastChatSessionId: uuid("last_chat_session_id"),
lastChatMessageId: text("last_chat_message_id"),
lastMemoryCreatedAt: timestamp("last_memory_created_at", { withTimezone: true }),
lastMemoryId: uuid("last_memory_id"),
updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
```

### A.7 `agent_memory_snapshots`
```
id uuid pk, agentId uuid notNull, sessionId uuid notNull UNIQUE,
renderedBlock text notNull, memoryIds jsonb, createdAt timestamptz notNull defaultNow
```

### A.8 `agent_consolidation_settings` (integers/basis points)
```
agentId uuid pk, enabled bool default false, autoApplyEnabled bool default false,
dryRun bool default true, minScoreBps int default 8000, minRecallCount int default 3,
minUniqueQueries int default 3, maxAgeDays int default 30, weights jsonb,
updatedAt timestamptz, updatedBy text
```

### A.9 `agent_consolidation_runs` / `_candidates` / `agent_phase_signals` / `agent_memory_events`
```
runs:       id, agentId, startedAt, finishedAt, status $type<ConsolidationRunStatus>,
            trigger $type<ConsolidationTrigger>, observationsScanned int, candidatesEvaluated int,
            candidatesPassed int, proposalsCreated int, error text
candidates: id, runId, agentId, claimKey text, snippet text, scoreBps int,
            gateResults jsonb, passed bool, proposalId uuid, createdAt timestamptz
phase:      id, agentId, claimKey text, lightHits int default 0, remHits int default 0,
            lastLightAt timestamptz, lastRemAt timestamptz
events:     id, agentId, eventType $type<MemoryEventType>, memoryId uuid, proposalId uuid,
            runId uuid, origin $type<MemoryEventOrigin>, summary text,
            detail jsonb $type<MemoryEventDetail>, createdAt timestamptz notNull defaultNow
```

### A.10 `drizzle.config.ts` `tablesFilter` — add ALL of these
```
agent_grounded_observations, agent_recall_signals, agent_phase_signals,
agent_ingestion_checkpoints, agent_memory_snapshots, agent_consolidation_settings,
agent_consolidation_runs, agent_consolidation_candidates, agent_memory_events
```
(Forgetting one means drizzle-kit silently won't manage it.)
