# Hermes Memory Findings — PostgreSQL-Only

## Purpose

This note cross-checks the **Write** and **Read** phases in
`agent-memory-prompt-v2.md` against the current Hermes implementation, then
records the allowed direction under this hard constraint:

> The memory subsystem may use PostgreSQL only. Do not require paid memory
> services, hosted rerankers, embedding APIs, vector databases, Redis, SQLite,
> or filesystem memory stores.

This is durable guidance for future agents. It separates verified current
behavior from the proposed PostgreSQL-only design. Do not present the target
design as behavior Hermes already has.

## Scope of the PostgreSQL-only constraint

For the proposed memory subsystem, PostgreSQL is the sole persistence, index,
queue, and retrieval system. PostgreSQL extensions such as `pg_trgm` are
acceptable because they run inside PostgreSQL. `pgvector` may be supported only
as an optional capability when already approved and installed; it is not a
baseline dependency and must not require an external embedding service.

Current Hermes is not PostgreSQL-only:

- Conversation sessions are persisted in SQLite by `SessionDB`.
- Built-in semantic memory is stored in `MEMORY.md` and `USER.md`.
- Existing external memory plugins use assorted local and hosted backends.

Therefore, a strict whole-agent requirement that *all Hermes persistence* use
PostgreSQL would require a separate SessionDB and built-in-memory migration.
This note scopes the target to the memory subsystem and does not claim that the
existing Hermes process is already globally PostgreSQL-only.

## Executive finding

Hermes implements two different memory paths:

1. **Built-in curated memory** — small, explicitly edited Markdown stores whose
   complete frozen snapshot is placed in the system prompt.
2. **One optional external provider** — completed turns can be synchronized in
   the background and query-dependent context can be recalled before a turn.

The framework in `agent-memory-prompt-v2.md` describes a more unified pipeline:
raw history is captured, durable knowledge is managed, and a common policy
ranks what is recalled. Hermes does not have that common write/read policy.
Its built-in path filters early and injects everything; provider paths capture
and rank according to backend-specific behavior.

Under the PostgreSQL-only constraint, do not adopt any existing paid or
service-backed memory provider. Implement the target as a **standalone
PostgreSQL `MemoryProvider` plugin** using Hermes's existing provider lifecycle.
Do not add a new in-tree memory provider: repository policy requires new memory
backends to ship as standalone plugins installed under
`~/.hermes/plugins/` or through a Python entry point (`CONTRIBUTING.md:72`).
Memory-provider discovery uses bundled-first precedence, so a standalone plugin
must use a unique provider name rather than attempting to replace a bundled
provider (`plugins/memory/__init__.py:16`).

## Verified current Hermes behavior

### Write phase

#### 1. Durable transcript and semantic memory are different things

`run_agent.py:_persist_session()` writes conversation state to the session log
and SQLite. This can retain user, assistant, tool-call, and tool-result history,
but it is not automatically the built-in semantic memory read on future tasks.
It is a historical transcript plane.

Built-in semantic writes go through the `memory` tool in
`tools/memory_tool.py`. They are deliberate, compact entries rather than raw
trajectory capture:

- targets: `memory` and `user`;
- operations: `add`, `replace`, `remove`, or an atomic batch;
- default character caps: 2,200 for memory and 1,375 for user profile;
- file locking and atomic replacement;
- duplicate rejection and external-drift protection;
- threat-pattern scanning;
- optional write approval.

The tool schema explicitly tells the model not to store raw dumps, task
progress, completed-work logs, or temporary TODO state. This is **curation at
write time**, not trace-first capture.

Evidence:

- `run_agent.py:1902`
- `tools/memory_tool.py:165`
- `tools/memory_tool.py:390`
- `tools/memory_tool.py:562`
- `tools/memory_tool.py:1160`

#### 2. External provider writes are asynchronous and best-effort

After a completed turn, `run_agent.py:_sync_external_memory_for_turn()` calls
`MemoryManager.sync_all()`. The manager uses a single background worker so
writes remain ordered without delaying the user-visible response.

Interrupted turns are intentionally not synchronized. Hermes treats partial
assistant output or an aborted tool chain as incomplete truth. The current
`MemoryProvider` contract therefore cannot reliably record interrupted or failed
turn status through `sync_turn()`—the finalizer returns before calling it.

If PostgreSQL must retain those events as trace evidence, first add a
backward-compatible generic provider hook such as
`on_turn_end(status, messages, metadata)` with a default no-op implementation,
and dispatch it for completed, failed, and interrupted exits. Keep
`sync_turn()` restricted to completed semantic ingestion. This is a concrete
extension of the existing provider surface, not a second memory pipeline.
Interrupted evidence may be stored with `status='interrupted'`, but it must not
be promoted into trusted semantic memory.

The provider interface can receive the full message list, including tool calls
and results, when the implementation accepts `messages=`. OpenViking currently
uses that richer path. Most current providers accept only the completed
user/assistant text pair.

Evidence:

- `run_agent.py:4197`
- `agent/memory_manager.py:675`
- `agent/memory_provider.py:173`
- `plugins/memory/openviking/__init__.py:4476`

#### 3. Hermes has no core decisions ledger

The built-in store contains free-form strings. It has no structured decision
ID, rationale, outcome, status, timestamp, or supersession relationship.
Provider-specific implementations may classify or search decisions, but that
is not a core contract and decisions are not guaranteed to be queried first.

#### 4. Temporal metadata is provider-specific

Built-in memory entries have no per-entry creation or modification timestamps.
The external mirror metadata includes origin, execution context, session,
platform, task, and tool-call provenance, but timestamp semantics are left to
the provider. Hindsight, RetainDB, and Holographic add their own timestamps;
this is not normalized by `MemoryManager`.

Evidence:

- `agent/background_review.py:627`
- `agent/memory_manager.py:1044`
- `plugins/memory/holographic/store.py:22`
- `plugins/memory/hindsight/__init__.py:1992`

#### 5. Built-in-to-provider mirroring can diverge

`MemoryManager.notify_memory_tool_write()` forwards successful `add`, `replace`,
and `remove` operations. Individual providers frequently implement only a
subset. Honcho, Holographic, Supermemory, RetainDB, and OpenViking primarily
mirror additions; replacement and removal may not update the provider copy.
A PostgreSQL-only design must not keep the Markdown store as an authoritative
peer, because the two stores can disagree after correction or deletion.

Evidence:

- `agent/memory_manager.py:1123`
- `plugins/memory/honcho/__init__.py:1464`
- `plugins/memory/holographic/__init__.py:245`
- `plugins/memory/supermemory/__init__.py:830`
- `plugins/memory/retaindb/__init__.py:785`
- `plugins/memory/openviking/__init__.py:4759`

### Read phase

#### 1. Built-in read is full bounded injection, not ranked recall

`MemoryStore.load_from_disk()` captures a sanitized snapshot. Every enabled
entry in that snapshot is rendered into the system prompt. Mid-session writes
are durable immediately but do not mutate the snapshot, preserving Hermes's
per-conversation prompt cache.

There is no query, relevance score, recency score, decision priority, or
selection step. Bounded size makes full injection practical, but it does not
implement the ranked recall policy described in `agent-memory-prompt-v2.md`.

Evidence:

- `tools/memory_tool.py:203`
- `tools/memory_tool.py:682`
- `agent/system_prompt.py:746`

#### 2. External recall is query-dependent but not centrally ranked

Before a non-trivial turn, `MemoryManager.prefetch_all()` asks the configured
provider for context. Hermes sanitizes the returned text, fences it in a
`<memory-context>` block, and appends it to the API-facing copy of the current
user message. The clean transcript remains unchanged; an `api_content` sidecar
preserves the exact sent bytes for later prompt-cache replay.

The manager:

- skips greetings, acknowledgements, slash commands, and empty prompts;
- permits only one external provider;
- fails open on provider errors;
- bounds an external prefetch call to eight seconds;
- concatenates provider-formatted text rather than structured scored records.

Therefore ranking, freshness, token/character budgeting, and conflict behavior
are backend-specific. The manager cannot enforce a decisions-first policy or
compare scores using a shared formula.

Evidence:

- `agent/memory_manager.py:525`
- `agent/memory_manager.py:634`
- `agent/turn_context.py:53`
- `agent/turn_context.py:1248`

#### 3. Recall freshness varies by provider

Some providers retrieve against the current query. Others consume context that
was warmed using the previous completed turn, or refresh profile/context only
at a configured cadence. Consequently automatic external recall is
best-effort and is not guaranteed to represent the current task.

Examples:

- Holographic, Supermemory, OpenViking, and ByteRover query at turn start.
- Hindsight's default asynchronous mode and RetainDB consume post-turn warmed
  results; Hindsight has an opt-in synchronous current-query mode.
- Honcho combines cached profile context with cadence-controlled dialectic
  results.

#### 4. Prompt-cache correctness retains historical recall blocks

The `api_content` sidecar is necessary: replay must contain the exact memory
context sent on the original turn or the cached prefix diverges. The tradeoff is
that old recalled blocks remain in API-visible history until compression. Even
selective per-turn retrieval can therefore accumulate duplicated or stale
context over a long conversation.

## PostgreSQL-only target design

### Integration boundary

Use the existing `MemoryProvider` ABC and `MemoryManager`; do not create a
parallel agent loop.

The standalone PostgreSQL provider should implement:

- `initialize()` — create/check schema and bind tenant, profile, user, and
  session identity;
- `sync_turn()` — append completed trace events without blocking the turn;
- `prefetch()` — run current-query ranked recall;
- `on_memory_write()` only for migration compatibility, not as a second source
  of truth;
- `on_session_end()` — finalize pending session records using SQL only;
- `on_session_switch()` — rotate session scope safely;
- `get_tool_schemas()` / `handle_tool_call()` — expose service-gated memory
  management only when the PostgreSQL provider is configured;
- `shutdown()` — bounded drain and connection cleanup.

Keep `system_prompt_block()` static. Dynamic memory belongs in `prefetch()` so
the system prompt remains byte-stable for the conversation.

### Sole source of truth

PostgreSQL must own semantic memory. Do not run the PostgreSQL provider as a
mirror of `MEMORY.md` / `USER.md` in steady state.

For a PostgreSQL-only memory profile:

- disable built-in memory/profile injection;
- keep the PostgreSQL provider active: current initialization reads
  `memory_enabled` / `user_profile_enabled` only when deciding whether to build
  the file-backed `MemoryStore`, while `memory.provider` is activated
  independently whenever `skip_memory` is false (`agent/agent_init.py:1757`,
  `agent/agent_init.py:1782`);
- do not depend on the built-in background-review fork, because it disables
  external providers and writes through the file-backed `memory` tool;
- let the PostgreSQL provider perform capture and consolidation through its own
  lifecycle hooks;
- provide an explicit provider tool for user/agent-approved add, update,
  supersede, and forget operations.

A one-time import from existing Markdown may be provided, but after import the
files are not read or mirrored.

### Write model

Use three related PostgreSQL planes.

#### A. Append-only trace events

Store the evidence needed to reconstruct what happened. Completed-turn events
can arrive through `sync_turn()`. Accurate failed/interrupted events require the
additive turn-finalization hook described above; do not infer their status from
`on_turn_start()` or silently claim they were captured.

Store:

- tenant/profile/user/session/turn IDs;
- event kind and role;
- user, assistant, tool-call, and tool-result content;
- tool name and outcome;
- `completed`, `failed`, or `interrupted` status;
- event time and ingestion time;
- provenance and provider-neutral metadata in `jsonb`;
- deterministic content hash for idempotency.

Never promote failed or interrupted output as established fact. Keeping those
events is still valuable for later debugging and outcome analysis.

#### B. Structured decisions ledger

A decision record should include:

- subject/task key;
- decision text;
- rationale;
- observed outcome;
- status: active, superseded, reverted, or uncertain;
- `decided_at`, `updated_at`, and optional `valid_until`;
- source event IDs;
- `superseded_by` relationship.

Updates append history and supersede the active record. Do not destroy the
historical rationale when a decision changes.

#### C. Curated memory items

A memory item should include:

- kind: user preference, environment fact, procedure, project fact, entity,
  event, or lesson;
- compact content;
- importance and confidence;
- validity interval;
- creation and modification timestamps;
- source event IDs and provenance;
- supersession/tombstone state;
- generated `tsvector` search document;
- optional tags and entities in normalized columns or `jsonb`.

Use transactions for an explicit write plus its provenance event. Enforce
idempotency with stable turn/tool-call keys and content hashes.

### Read model

#### 1. Lexical-first candidate retrieval

The required baseline uses PostgreSQL-native retrieval only:

- full-text matching with `tsvector`, `websearch_to_tsquery`, and
  `ts_rank_cd`;
- typo/name overlap with `pg_trgm` similarity;
- exact tenant/profile/user/project filters;
- active-validity and tombstone filters.

This is ranked lexical recall, not equivalent to embedding-based semantic
search. It will miss some paraphrases. Agents must not describe it as semantic
recall unless optional in-PostgreSQL vectors are actually enabled and populated
without a paid embedding service.

#### 2. Two-stage recall policy

For every substantive current query:

1. Retrieve active relevant decisions first, including rationale and known
   outcome.
2. Retrieve other memory candidates.
3. Rank with a documented combination of:
   - `ts_rank_cd` relevance;
   - trigram similarity;
   - importance;
   - confidence;
   - type-specific freshness;
   - explicit decision boost;
   - penalties for uncertainty or near-expiry.
4. Deduplicate by normalized content and supersession lineage.
5. Return only the highest-value records within fixed result and character
   budgets.

Decisions-first is adopted from the conceptual framework; it is a target policy,
not something current Hermes has validated universally.

Do not apply one aggressive recency decay to every kind. A stable user
preference may remain valid for years, while current location or deployment
state may become stale quickly. Freshness must depend on memory kind and
explicit validity metadata.

#### 3. Context and cache hygiene

- Keep the system prompt static.
- Inject recall only on the current user message through Hermes's existing
  fenced-context path.
- Use character budgets, consistent with Hermes's model-independent memory
  accounting; optionally report an estimated token count for observability.
- Return compact records with dates and provenance, not raw trace dumps.
- Do not recursively persist recalled `<memory-context>` blocks as new user
  evidence.
- Mark recalled text as reference data, never executable instructions.
- Preserve the `api_content` replay contract until compression.

### Security and isolation requirements

- Parameterize every SQL query.
- Scope every row and every retrieval query by tenant/profile/user as
  applicable; use PostgreSQL row-level security where multiple identities
  share a database.
- Encrypt transport with TLS and keep credentials in the existing secret
  configuration path.
- Scan explicit and extracted memories for prompt-injection/exfiltration
  patterns before they become recall-visible.
- Store tool outputs as untrusted evidence.
- Keep migrations additive and reversible.
- Bound connection pools, write queues, query time, row counts, and returned
  characters.
- Fail open for conversational availability: a PostgreSQL recall outage must
  not block the user's turn.
- Fail closed for uncertain writes: do not acknowledge a durable memory until
  its transaction commits.

## Explicitly excluded approaches

Future agents must not propose any of the following for this design:

- Honcho, Mem0 Platform, Hindsight service, Supermemory, RetainDB, ByteRover,
  OpenViking, or another memory daemon/service;
- Pinecone, Weaviate, Qdrant, Chroma, Elasticsearch, Redis, or another database;
- hosted embeddings, hosted reranking, or paid memory extraction APIs;
- SQLite or Markdown as an authoritative memory store;
- a second always-on core model tool;
- mutable per-turn system-prompt memory;
- unranked injection of all PostgreSQL memories.

Existing provider code remains useful as implementation evidence, but not as an
allowed runtime dependency.

## Acceptance criteria for a future implementation

A PostgreSQL-only memory implementation is not complete unless tests prove:

1. Completed user/assistant and tool events are appended once with timestamps
   and provenance.
2. Interrupted/failed events remain traceable but cannot become trusted active
   memories automatically.
3. Decisions preserve rationale and outcomes across supersession.
4. Replace, supersede, and forget operations cannot leave a second
   authoritative store stale.
5. Retrieval is tenant/profile/user isolated.
6. Relevant active decisions are considered before general memory.
7. Expired, superseded, tombstoned, and injection-blocked records are excluded.
8. Returned context obeys deterministic result and character budgets.
9. Trivial prompts skip automatic recall.
10. PostgreSQL timeout or unavailability does not prevent the main agent from
    responding; recall uses a bounded join no longer than the manager's existing
    external-prefetch timeout (`agent/memory_manager.py:525`).
11. Writes are acknowledged only after commit and are idempotent on retry.
12. Recalled context does not contaminate subsequent write extraction.
13. The system prompt stays byte-stable during a conversation.
14. No test or runtime path requires a paid service or non-PostgreSQL memory
    backend.

## Final conclusion

Hermes already provides the correct lifecycle seams, prompt-cache discipline,
background-write ordering, and turn-level recall injection needed for a strong
memory loop. What it lacks is a provider-neutral structured write model and a
common ranked read policy.

Under the stated constraint, the appropriate direction is one standalone,
PostgreSQL-native `MemoryProvider` with PostgreSQL as the sole semantic-memory
source of truth. Preserve raw trace evidence, promote only validated facts and
decisions, reconcile changes through supersession, and perform bounded
current-query recall using PostgreSQL-native ranking. Do not add or depend on a
paid memory product to fill these gaps.
