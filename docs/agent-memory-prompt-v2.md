# The Write-Manage-Read Memory Loop: A Conceptual Framework for Self-Improving Agents

Rather than treating memory as a passive vector database or an append-only log, modern agent architectures conceptualize memory as an active **control loop** operating around a language model. This framework bridges the gap between raw point-in-time intelligence and cumulative, situated expertise [114, 116, 164].

The active memory loop is divided into three core functional phases: **Write (Information Capture)**, **Manage (Consolidation & Synthesis)**, and **Read (Ranked Recall)** [164, 165].

---

## 1. The Write Phase: Governed Capture, Evidence, and Promotion

The write phase decides what may become durable, preserves what actually happened, and promotes only supported material into reusable memory. It is not a single `remember(text)` call. Persistent memory can steer later behavior, so it is both sensitive data and part of the agent's control plane ([Microsoft, 2026-06-03](https://learn.microsoft.com/en-us/security/zero-trust/sfi/manage-agentic-memory-safety)).

The central design rule is to separate **evidence** from **interpretation**. A tool returning `404` is evidence; “the endpoint was removed” is an interpretation. A compact memory may be useful, but it must not replace the events that support or contradict it.

> **Synthesis / proposal:** use three PostgreSQL write planes: append-only trace events, a structured decisions-and-outcomes ledger, and versioned curated memory items. Public systems document pieces of this pattern, but the complete decisions ledger proposed below is ahead of the reviewed public product practice.

### 1.1 Three write planes

| Plane | Question answered | Mutation model | Typical retention |
|---|---|---|---|
| **Trace events** | What did the system observe, request, execute, and receive? | Append-only; corrections are new events | Short or policy-specific |
| **Decisions ledger** | What was selected, under which declared basis, and what later happened? | Append outcomes; supersede decisions | Audit- and task-lifecycle-driven |
| **Curated items** | What compact fact, episode, procedure, preference, or lesson is useful later? | Versioned; conflict policy depends on kind | Consent-, validity-, and utility-driven |

This split combines trace observability with selective memory rather than treating every trace as trusted knowledge. OpenAI's Agents SDK describes tracing as workflow observability, not automatic semantic memory ([OpenAI, 2025-03-11](https://openai.com/index/new-tools-for-building-agents/)). LangMem separately models semantic facts, episodic experience, and procedural behavior ([LangChain, 2025-02-18](https://www.langchain.com/blog/langmem-sdk-launch)).

The prompt projection is a fourth, ephemeral product of READ. It is never the source of truth and must not be written back as fresh user evidence.

### 1.2 What the writer may produce

Use typed records rather than undifferentiated summaries:

- **Semantic:** stable or time-bounded facts, preferences, constraints, and entity relations.
- **Episodic:** a compact account of one task, interaction, success, or failure linked to its trace.
- **Procedural:** a reusable workflow, precondition, policy, or failure-avoidance rule.
- **Decision:** selected option, declared rationale, assumptions, expected result, and success criteria.
- **Outcome:** later observations that support, contradict, or leave a decision inconclusive.
- **Temporal relation:** an assertion whose real-world validity differs from when it was recorded.
- **Artifact reference:** content hash, metadata, and bounded excerpt for a file or tool result.
- **Non-memory:** greetings, duplicates, transient state, unsupported model speculation, secrets, and policy-prohibited material.

Agent Workflow Memory extracts reusable workflows from action trajectories, while Memp and ReasoningBank distill procedures or lessons from successes and failures ([Agent Workflow Memory, 2025-10-06](https://proceedings.mlr.press/v267/wang25bx.html); [Memp, 2025-08-08](https://arxiv.org/abs/2508.06433); [ReasoningBank, 2025-09-29](https://arxiv.org/abs/2509.25140)). These are published findings about trajectory distillation—not evidence that every completed trajectory deserves promotion.

A-MEM further shows a write-time organization pattern: structured notes gain descriptions, keywords, tags, and links, and later information can evolve earlier notes ([A-MEM, 2025-02-17](https://arxiv.org/abs/2502.12110)). In this design, “evolve” means creating a provenance-bearing version or relation, never silently mutating history.

### 1.3 Write pipeline

#### Stage 0 — authorize before persistence

Resolve tenant, user, agent, session, purpose, and retention class before writing bytes. Then:

- verify that the caller may write the target scope;
- honor temporary or no-memory mode;
- cap payload and artifact size;
- redact credentials, private keys, tokens, payment data, and prohibited identifiers;
- block unsupported sensitive inferences;
- classify source trust: `user_assertion`, `tool_observation`, `third_party_content`, `model_inference`, or `evaluator_result`;
- attach policy version, actor, source, and expiry.

A valid interaction is not automatically a trustworthy memory source. MINJA demonstrates that query-only interaction can induce malicious records for later retrieval ([MINJA, 2025-03-05](https://arxiv.org/abs/2503.03704)). Microsoft consequently recommends write authorization, provenance, isolation, sensitive-data controls, user CRUD controls, and memory audit logging ([Microsoft, 2026-06-03](https://learn.microsoft.com/en-us/security/zero-trust/sfi/manage-agentic-memory-safety)).

**Failure rule:** writes fail closed. Never acknowledge durable memory until the PostgreSQL transaction commits. A rejected or deferred candidate should have a machine-readable reason, but prohibited content should not be copied into an unrestricted rejection log.

#### Stage 1 — journal authorized evidence synchronously

In one short transaction:

1. claim a tenant-scoped idempotency key;
2. insert bounded, redacted event data;
3. reference a content-addressed artifact when needed;
4. enqueue a distillation job in the same transaction; and
5. commit before acknowledging capture.

Useful event kinds include `user_message`, `assistant_message`, `model_generation`, `tool_requested`, `tool_result`, `environment_observation`, `guardrail_result`, `feedback`, `decision_declared`, `outcome_observed`, and `task_terminal_state`.

Retain failed or interrupted events as evidence, but never promote incomplete output as established fact merely because it exists. “Append-only” means append all **authorized, bounded** events—not every byte and never every secret.

Do not call a model while holding the database transaction open. If extraction fails, the journal and queued job remain retryable; if the transaction fails, neither should appear.

#### Stage 2 — claim background work safely

Workers claim small batches with a lease:

```sql
WITH picked AS (
  SELECT job_id
  FROM memory_write_jobs
  WHERE status = 'queued'
    AND run_after <= now()
    AND attempts < max_attempts
  ORDER BY priority DESC, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 20
)
UPDATE memory_write_jobs j
SET status = 'running',
    lease_owner = $1,
    lease_expires_at = now() + interval '2 minutes',
    attempts = attempts + 1,
    updated_at = now()
FROM picked
WHERE j.job_id = picked.job_id
RETURNING j.*;
```

`SKIP LOCKED` is a PostgreSQL locking option; using it as a queue still requires deterministic uniqueness, lease expiry, retry caps, a stale-job reaper, and dead-letter state ([PostgreSQL 18 `SELECT`, 2025-09-25](https://www.postgresql.org/docs/18/sql-select.html)). Model work happens after the claim transaction commits.

The reaper changes an expired `running` lease to `queued`, clears its lease fields, sets a backoff in `run_after`, and updates `updated_at` only when `attempts < max_attempts`; otherwise it changes the job to terminal `dead_letter`. A worker failure uses the same guarded transition and records `last_error`. `dead_letter` jobs are never claimable and remain available for inspection or an explicit operator-driven retry.

#### Stage 3 — assemble and sanitize evidence

Construct a bounded extraction window that preserves roles, event order, tool request/result pairing, source time, and terminal status. Replace oversized artifacts with metadata plus bounded excerpts rather than truncating structured evidence mid-record.

Before extraction:

- scan again for secrets introduced by tool output;
- normalize timestamps to UTC while preserving source timezone and precision;
- deduplicate retransmitted events with stable hashes;
- use deterministic aliases plus `pg_trgm` only to propose entity matches;
- prevent instructions embedded in web or tool content from controlling the extractor.

PostgreSQL's `pg_trgm` supplies similarity functions and GiST/GIN indexes for fuzzy candidates; it should not make final identity decisions by itself ([PostgreSQL 18 `pg_trgm`, 2025-09-25](https://www.postgresql.org/docs/18/pgtrgm.html)).

#### Stage 4 — extract typed candidates, not SQL

An open-source model running locally may emit schema-constrained candidates such as:

```json
{
  "memory_type": "semantic|episodic|procedural|decision|outcome|relation",
  "canonical_key": "optional stable key",
  "content": "compact human-readable statement",
  "structured": {},
  "evidence_event_ids": [],
  "source_stance": "observation|assertion|interpretation|evaluation",
  "valid_from": null,
  "valid_to": null,
  "time_precision": "instant|day|month|year|unknown",
  "confidence": 0.0,
  "proposed_operation": "ADD|UPDATE|INVALIDATE|NOOP|REVIEW"
}
```

Require supporting event IDs or spans for every assertion. Store extractor/model ID, prompt hash, schema version, and policy version. Reject unsupported candidates; do not let the model execute SQL.

#### Stage 5 — gate by safety and expected utility

Apply deterministic rules before a scored policy.

**Hard accept candidates:** an authorized explicit “remember this,” a confirmed correction, an outcome needed to close an open decision, or a required audit record—subject to sensitivity policy.

**Hard reject or quarantine:** secrets, cross-tenant references, unsupported claims, malformed time intervals, instructions sourced only from untrusted retrieved content, or attempts to rewrite safety and permission state.

Selective writing matters because retrieved experience can induce similar future behavior, including error propagation and misaligned replay ([How Memory Management Impacts LLM Agents, 2025-05-21](https://arxiv.org/abs/2505.16067)). NEMORI proposes prediction error as a signal for novelty worthy of consolidation ([NEMORI, 2026-07](https://aclanthology.org/2026.acl-long.1607/)).

> **Synthesis / starting point, not a published formula:** score remaining candidates using predicted future utility, novelty or prediction error, evidence quality, outcome relevance, explicit user intent, expected lifetime, and corroboration; subtract sensitivity, duplication, contradiction, and indexing costs. Tune weights on downstream task outcomes, not extraction aesthetics.

#### Stage 6 — reconcile by memory family

No single conflict strategy dominates current work:

- Graphiti records valid and transaction times and can invalidate temporally overlapping contradictions ([Zep/Graphiti, 2025-01-20](https://arxiv.org/abs/2501.13956)).
- Memory-R1 learns `ADD`, `UPDATE`, `DELETE`, and `NOOP` choices ([Memory-R1, 2025-08-27](https://arxiv.org/abs/2508.19828)).
- Mem0 2.0 moved to one-pass, ADD-only extraction and defers reconciliation to retrieval; its reported gains are vendor-reported rather than independent validation ([Mem0 migration guide, 2026-04-14](https://docs.mem0.ai/migration/oss-v2-to-v3); [Mem0 2.0.0, 2026-04-16](https://pypi.org/project/mem0ai/2.0.0/)).

Use an explicit policy per family:

| Family | Proposed default | Reason |
|---|---|---|
| Confirmed user preference/profile | Replace current, retain versions | Authorized corrections should become visible immediately |
| Tool-observed state | Append temporal | State changes; observation and validity both matter |
| Third-party assertion | ADD-only, reconcile on read | A later arrival is not automatically more authoritative |
| Procedure/workflow | Version and evaluate | Applicability changes with outcomes |
| Safety, identity, permission | Deterministic authority or human review | A model must not rewrite control state |
| Episode | Append, then compact | Preserve episode identity and provenance |

This table is an engineering synthesis. It deliberately preserves the tension between cheap ADD-only capture and lower-ambiguity write-time reconciliation.

#### Stage 7 — commit derived records atomically

Commit the stable item, new version, provenance joins, decision/outcome links, lexical document, and embedding job status in a short transaction. A derived item remains searchable through native full-text search while an optional embedding is pending.

Use a local open-source embedding model when semantic search is enabled. Keep embeddings in a table keyed by `(memory_version_id, embedding_model_id)` so model changes do not rewrite canonical memory. Start with exact vector scans for small scoped sets; add HNSW only after measurement. pgvector 0.8.0 documents iterative scans and filtered approximate-search improvements, but approximate indexes still add write and maintenance cost ([pgvector 0.8.0, 2024-11-11](https://www.postgresql.org/about/news/pgvector-080-released-2952/)).

#### Stage 8 — close the outcome loop

When later evidence establishes an outcome:

- append the outcome event;
- link it to the relevant decision, procedure, episode, and trace;
- evaluate stored success criteria;
- add a confidence/utility score event or new version;
- narrow or deprecate a procedure only after configured evidence or review.

Later evaluations can label which memories influenced success or failure, while procedural-memory research supports revising or deprecating workflows as experience changes ([How Memory Management Impacts LLM Agents, 2025-05-21](https://arxiv.org/abs/2505.16067); [Memp, 2025-08-08](https://arxiv.org/abs/2508.06433)). Completion alone is not success.

### 1.4 Decisions and outcomes ledger

A transcript records what was said; a trace records what ran; a decision record states what was selected and what result would count as success.

> **Synthesis / proposal ahead of public practice:** none of the reviewed public materials specifies the full tuple below as one first-class primitive. AWM, Memp, and ReasoningBank are adjacent evidence for workflow and lesson distillation, not proof that this ledger is a settled standard ([Agent Workflow Memory, 2025-10-06](https://proceedings.mlr.press/v267/wang25bx.html); [Memp, 2025-08-08](https://arxiv.org/abs/2508.06433); [ReasoningBank, 2025-09-29](https://arxiv.org/abs/2509.25140)).

Minimum decision record:

```text
decision_id; subject_key; tenant/profile/user/project/task/agent scope
trace_id; context_event_ids[]
selected_option; declared_options[]; declared_rationale; assumptions[]
expected_outcome; success_criteria[]; constraints[]; confidence
decided_at; recorded_at; valid_during; recorded_during
decider/model/prompt/policy versions
visibility; ACL principals; sensitivity class; source authority
revoked_at; tombstoned; injection_blocked
status: open|succeeded|failed|mixed|superseded|unknown
supersedes_decision_id
```

Index active lookup by scoped `subject_key` and `status`, with GiST indexes on `valid_during` and `recorded_during`. Outcomes are append-only children containing observed state, metrics, evidence IDs, event and record times, evaluator version, assessment, and confidence.

Correctness rules:

- store a concise **declared rationale**, never private chain-of-thought;
- do not invent alternatives that were not declared;
- do not infer success from action completion;
- allow multiple observations and evaluators;
- preserve the historical decision when a procedure is downgraded;
- require deterministic authority or confirmation for high-impact decisions.

### 1.5 Bitemporal history: two clocks, not one

Graphiti distinguishes event chronology from transaction chronology ([Zep/Graphiti, 2025-01-20](https://arxiv.org/html/2501.13956v1)). Adopt that distinction:

| Column | Meaning |
|---|---|
| `occurred_at` / `event_time` | When the source event happened |
| `ingested_at` | When the journal accepted it |
| `valid_during tstzrange` | Real-world interval believed true |
| `recorded_during tstzrange` | Interval this database version was current |
| `source_reference_time` | Anchor for relative dates such as “yesterday” |
| `time_precision`, `time_source` | Known granularity and origin |
| `expires_at` | Retention/use expiry, not real-world invalidity |
| `last_confirmed_at` | Latest corroborating event time |

Use half-open ranges `[start, end)`. PostgreSQL range types provide bounds, overlap operators, GiST indexes, and exclusion constraints ([PostgreSQL 18 range types, 2025-09-25](https://www.postgresql.org/docs/18/rangetypes.html)). Apply non-overlap constraints only where one current value is a true invariant. Competing assertions may legitimately overlap.

Never manufacture exact dates. Preserve null bounds, source timezone, precision, and the reference time used to resolve relative expressions.

### 1.6 Compact PostgreSQL mapping

```text
memory_events(
  event_id, tenant_id, user_id, agent_id, session_id, trace_id, span_id,
  event_type, actor, trust_class, sensitivity_class, payload jsonb,
  artifact_hash, occurred_at, ingested_at, expires_at, content_hash, policy_version)

memory_event_keys(
  tenant_id, idempotency_key, event_id, event_ingested_at, first_seen_at,
  PRIMARY KEY (tenant_id, idempotency_key))

memory_artifacts(
  artifact_hash bytea PRIMARY KEY, media_type, byte_size, encoding, compression,
  redacted_excerpt, content bytea, created_at, expires_at, sensitivity_class,
  CHECK (content IS NULL OR octet_length(content) <= 262144))

memory_write_jobs(
  job_id, tenant_id, event_id, job_kind, status, priority, run_after,
  attempts, max_attempts, lease_owner, lease_expires_at,
  extractor_version, policy_version, last_error, created_at, updated_at,
  UNIQUE (tenant_id, event_id, job_kind, extractor_version))

memory_items(
  memory_id, tenant_id, scope_type, scope_id, memory_type,
  canonical_key, conflict_policy, status, created_at)

memory_versions(
  memory_version_id, memory_id, version_no, content, structured jsonb,
  valid_during tstzrange, recorded_during tstzrange,
  confidence, utility_score, operation, supersedes_memory_version_id,
  extractor_id, model_id, prompt_hash, policy_version)

memory_version_sources(memory_version_id, event_id, source_role, source_span jsonb)
agent_decisions(...); agent_outcomes(decision_id, ...)
memory_embeddings(memory_version_id, embedding_model_id, embedding vector(1024))
```

`memory_event_keys` is the unpartitioned, tenant-scoped idempotency registry; a hash on `memory_events` is evidence, not the uniqueness mechanism. `memory_artifacts` is content-addressed and keeps at most 256 KiB inline; larger artifacts retain only hash, metadata, and a bounded redacted excerpt. `agent_decisions` carries the same scope, visibility, ACL, sensitivity, authority, validity, recorded-time, revocation, tombstone, and injection-block columns used by the Read hard gates.

Keep scope, time, status, provenance, and lifecycle as constrained relational columns; reserve `jsonb` for evolving typed details. PostgreSQL recommends `jsonb` for efficient processing and indexing where exact textual preservation is unnecessary ([PostgreSQL 18 JSON types, 2025-09-25](https://www.postgresql.org/docs/18/datatype-json.html)).

Use native FTS and GIN for lexical search, `pg_trgm` for fuzzy aliases, optional `pgvector` for local embeddings, and `pg_cron` for coarse lifecycle maintenance. `pg_cron` should reap stale leases, enqueue consolidation, expire eligible data, and maintain partitions—not replace the freshness-sensitive queue ([pg_cron 1.6.6, 2025-09-04](https://github.com/citusdata/pg_cron/releases/tag/v1.6.6)).

Enforce tenant isolation with row-level security plus non-owner application roles. PostgreSQL RLS defaults to deny when enabled without a policy, but owners and bypass roles require careful handling ([PostgreSQL 18 row security, 2025-09-25](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)).

### 1.7 Operational invariants and evaluation

The writer is not ready unless:

- no durable row lacks scope, actor, source, timestamps, retention class, and policy version;
- no derived assertion lacks evidence links;
- no model call occurs inside an open database transaction;
- retries are idempotent and leases have caps plus dead-letter handling;
- failed/interrupted traces cannot become trusted active memories automatically;
- corrections, supersession, and deletion cannot leave a second authority stale;
- high-risk permission or safety state cannot be rewritten autonomously;
- every accepted explicit write is acknowledged only after commit.

Measure capture correctness separately from final answer quality: unsupported-claim rate, secret-block false positives/negatives, cross-scope violations, duplicate rate, temporal parse accuracy, user correction/deletion rate, later retrieval/use rate, procedure success after promotion, queue age, dead letters, index growth, expiry SLA, and downstream task lift against a no-memory or prior-writer control.

The write phase is therefore a governed, reversible data pipeline: durable evidence first, selective promotion second, outcome-linked revision later.

**Write/Manage boundary:** Write owns journaling, candidate extraction, promotion, conflict reconciliation, provenance, and version commits. Manage may periodically perform cross-item compaction and profile synthesis, but it is not an independent mutation path: every managed result must commit through the same Write conflict, authority, provenance, and versioning rules. A managed artifact may be larger than a per-turn projection; Read selects only a bounded subset for the current task.

---

## 2. The Manage Phase: Asynchronous Consolidation & Synthesis
A major bottleneck in long-running agents is "context rot" and "context bloat," where the accumulation of raw, redundant chat logs causes models to contradict themselves, drift from instructions, or repeat past mistakes [162]. The manage phase acts as a background processing system to compress and restructure raw logs into stable, reusable knowledge structures [114].

*   **"Dreaming" & Sleep-Time Compute:** An asynchronous background process where an offline model periodically reviews raw traces and conversation histories [104, 148, 176]. It filters out transactional noise and distills core facts [104].
*   **Structured Running Profiles:** Condensing highly conversational history into a compressed, dense, yet human-readable user or environment profile [148, 152]. Real-world implementations utilize complete sentences and set strict token budgets (e.g., 1,000 to 4,000 tokens) to balance serving costs [152, 155].
*   **Temporal Reconciliation & Conflict Resolution:** Actively parsing memory to identify and resolve factual contradictions caused by changing real-world conditions (e.g., stale travel itineraries vs. current locations) [147, 150, 159].
*   **Interconnected Wikis and Backlinking:** Structuring notes dynamically by applying constrained tags and programmatically linking related nodes (decisions, sessions, topics) [128, 129]. This constructs an interconnected "web of thoughts" that allows agents to trace logical paths [128, 132].

---

## 3. The Read Phase: Scoped, Ranked, and Budgeted Recall

The read phase decides **whether to recall, where to search, how to rank, what to suppress, and how much evidence to inject**. LongMemEval separates memory indexing, retrieval, and reading, and shows that better retrieval does not remove the need for a good reading strategy ([LongMemEval, 2024-10-14](https://arxiv.org/abs/2410.10813)).
```text
trigger → scope and authority gates → candidate generation → fusion
        → freshness/conflict checks → optional rerank → sufficiency
        → token-budgeted evidence injection
```
Each boundary matters. A reranker cannot recover a row excluded by candidate generation; a close vector match cannot make an expired assertion current; and accurate evidence can still hurt when surrounded by too much irrelevant context.
> **Synthesis / proposal:** use a two-stage policy for every substantive task: (1) exact, decisions-first lookup by scope, status, and time; then (2) ranked general recall. Decisions-first is deliberately ahead of common public practice and should be evaluated, not presented as universally validated.
### 3.1 Three retrieval triggers
#### Always-loaded index
Freeze only immutable hard operating rules, identity, and safety constraints in the conversation system prompt. That prompt must remain byte-stable for the entire conversation; it is not a per-turn memory projection.

Current objectives, project state, hard task constraints, and IDs of active decisions are dynamic. Fetch them on every substantive turn through the existing fenced `prefetch()` recall path attached to the current user message, after applying the same scope and authority gates as other recall. Preserve each historical turn's exact `api_content`, including its recall block, until compression so prompt-cache replay remains byte-identical.

Claude Code's documented pattern uses bounded startup memory plus on-demand topic files, while Anthropic's context-engineering guidance recommends lightweight references and just-in-time retrieval rather than front-loading all potentially relevant data ([Claude Code memory docs, current 2026-08-15](https://code.claude.com/docs/en/memory); [Claude Code v2.1.59, 2026-02-26](https://github.com/anthropics/claude-code/releases/tag/v2.1.59); [Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Letta similarly separates pinned context from searchable recall and archival memory ([Letta, 2025-07-07](https://www.letta.com/blog/agent-memory/)).

Both layers must remain bounded and inspectable. Deep rationale and source material stay addressable by ID.
#### Deterministic pre-turn retrieval
Run a fixed lookup before planning when omission is more costly than one small query: active decisions, unresolved commitments, current project constraints, and known supersessions.

LongMemEval reports benefits from fact-augmented indexing and time-aware query expansion for sustained, temporal, and knowledge-update questions ([LongMemEval, 2024-10-14](https://arxiv.org/abs/2410.10813)). This supports structured pre-turn retrieval rather than relying only on similarity to the latest wording.
#### On-demand agent retrieval
Expose a bounded tool such as `search_memory(query, filters, limit)` for details, examples, old incidents, source evidence, and multi-hop questions. LangMem distinguishes prompt-resident memory from data-dependent recall by similarity, application context, time, or combinations of signals ([LangChain, 2025-02-18](https://www.langchain.com/blog/langmem-sdk-launch)). Anthropic calls the broader pattern just-in-time context ([Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

On-demand recall saves tokens but can fail because the model does not call the tool or writes a poor query. Memory-R1 and AgeMem respond by making retrieval and other memory operations explicit policy actions ([Memory-R1, 2025-08-27](https://arxiv.org/abs/2508.19828); [AgeMem, 2026-01-05](https://arxiv.org/abs/2601.01885)). Therefore, reserve deterministic lookup for must-not-miss state and agentic retrieval for exploratory needs.

| Memory class | Default trigger | Treatment |
|---|---|---|
| Hard policy / identity / safety constraints | Always loaded | Tiny, authoritative, not similarity-ranked |
| Active decisions / unresolved commitments | Deterministic task-start query | Exact scope, status, validity, supersession |
| Current user/project state | Pre-turn metadata lookup | Prefer current authoritative observations |
| Episodes / incidents / examples | On demand | Retrieve only for relevant subtasks |
| Rationale / source evidence | On demand from an ID | Keep reachable without permanent token cost |
| Stale, conflicting, or untrusted material | Evidence only | Never treat retrieval as authority |
### 3.2 Stage one: decisions-first exact lookup
Resolve scope before relevance:
1. bind tenant, profile, user, project, task, agent, allowed visibility and ACL principals, sensitivity policy, source authority, and valid/recorded as-of times;
2. query active decisions and unresolved commitments by indexed columns;
3. require `valid_during @> $as_of` where validity is known and `recorded_during @> $recorded_as_of` for transaction-time travel;
4. select non-superseded heads; walk `supersedes_decision_id` backward only when historical predecessors are requested;
5. return a compact summary, status, success criteria, outcome, and source IDs;
6. fetch detailed rationale or trace evidence only if the task touches that decision.

A representative current-view query is intentionally ordinary SQL. Historical inspection may admit superseded lifecycle states under a separate authorization policy, but it must not weaken identity, ACL, sensitivity, authority, or recorded-time gates. Request-bound arrays are computed by the authorization layer, not by the model:
```sql
-- $1 tenant; $2 project; $3 valid as-of; $4 subject keys; $5 limit;
-- $6 recorded as-of; $7 profile; $8 user; $9 task; $10 agent;
-- $11 visibility; $12 ACL principals; $13 sensitivity; $14 source authority.
SELECT decision_id, subject_key, selected_option, status,
       expected_outcome, success_criteria, decided_at,
       supersedes_decision_id
FROM agent_decisions
WHERE tenant_id = $1
  AND (profile_id IS NULL OR profile_id = $7)
  AND (user_id IS NULL OR user_id = $8)
  AND (project_id IS NULL OR project_id = $2)
  AND (task_id IS NULL OR task_id = $9)
  AND (agent_id IS NULL OR agent_id = $10)
  AND visibility = ANY($11::text[])
  AND acl_principal_ids && $12::uuid[]
  AND sensitivity_class = ANY($13::text[])
  AND authority = ANY($14::text[])
  AND status <> 'superseded'
  AND revoked_at IS NULL
  AND NOT tombstoned
  AND NOT injection_blocked
  AND (valid_during IS NULL OR valid_during @> $3::timestamptz)
  AND recorded_during @> $6::timestamptz
  AND (status IN ('open', 'mixed', 'unknown')
       OR subject_key = ANY($4::text[]))
ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, decided_at DESC
LIMIT $5;
```
> **Synthesis / limitation:** decisions-first should reduce accidental policy drift and repeated failed choices, but no reviewed source establishes it as the universal best first stage. Measure whether the ledger contains relevant decisions, whether they change behavior correctly, and whether stale decisions crowd out current evidence.
### 3.3 Stage two: general candidate generation
After decision lookup, search independent lanes:
- **dense semantic:** paraphrases and conceptual similarity through `pgvector`;
- **lexical:** exact terms, error strings, names, and identifiers through native FTS;
- **fuzzy:** misspellings and near-exact aliases through `pg_trgm`;
- **metadata:** kind, status, authority, project, task, and entity filters;
- **temporal:** current, historical, upcoming, and duration intent;
- **relation:** bounded traversal through an edge table and recursive CTE;
- **recent working set:** last interactions or recently used items, with a cap.

Current Mem0 retrieval guidance describes semantic, lexical/BM25, entity, filter, and reranking stages; hosted features are not required to reproduce the general pipeline ([Mem0 retrieval strategies, 2026-05-11](https://mem0.ai/blog/memory-retrieval-strategies-for-ai-agents)). Graphiti exposes lexical/semantic retrieval plus RRF and graph-aware reranking recipes ([Graphiti release, 2026-07-27](https://github.com/getzep/graphiti/releases/tag/v0.29.3); [`search_config_recipes.py`](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_config_recipes.py)). These are design references, not runtime dependencies.

A PostgreSQL-only baseline can begin with native FTS plus `pg_trgm`. Add the dense lane only when an approved open-source local embedding model is available. Do not describe lexical retrieval as semantic recall, and do not require a hosted embedding API.

Hard predicates must run in every lane **before** ranking:
- tenant/profile/user/project/task/agent authorization plus allowed visibility and ACL principals;
- tombstone, revocation, and injection-block status;
- requested historical versus current view;
- valid/recorded time boundaries;
- allowed sensitivity and source authority.

Identity and ACL are security boundaries, not low-weight ranking features. LangMem's namespaces and current retrieval interfaces use scoped filtering as a first-class boundary ([LangChain, 2025-02-18](https://www.langchain.com/blog/langmem-sdk-launch); [Mem0 retrieval strategies, 2026-05-11](https://mem0.ai/blog/memory-retrieval-strategies-for-ai-agents)).
### 3.4 Fuse ranks rather than raw scores
Cosine distance, `ts_rank_cd`, and trigram similarity have different scales. Fuse lane ranks instead of pretending their raw values are calibrated.

Weighted reciprocal rank fusion is a practical starting point:
\[
RRF(m)=\sum_{j \in lanes}\frac{w_j}{k+rank_j(m)}
\]
RRF is a ranking value, not a probability. `k=60` and lane weights are initialization choices that must be tuned on the target workload, not universal constants. ParadeDB documents this weighted-RRF pattern for hybrid PostgreSQL search ([ParadeDB, 2025-10-22](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual)).

Compact PostgreSQL pattern:
```sql
-- $1 query vector; $2 tenant; $3 project; $4 valid as-of; $5 model;
-- $6 lexical query; $7 recorded as-of; $8 profile; $9 user; $10 task;
-- $11 agent; $12 visibility; $13 ACL principals; $14 sensitivity;
-- $15 source authority. Authorization computes every request-bound array.
WITH eligible AS MATERIALIZED (
  SELECT d.*
  FROM recall_documents d
  WHERE d.tenant_id = $2
    AND (d.profile_id IS NULL OR d.profile_id = $8)
    AND (d.user_id IS NULL OR d.user_id = $9)
    AND (d.project_id IS NULL OR d.project_id = $3)
    AND (d.task_id IS NULL OR d.task_id = $10)
    AND (d.agent_id IS NULL OR d.agent_id = $11)
    AND d.visibility = ANY($12::text[])
    AND d.acl_principal_ids && $13::uuid[]
    AND d.sensitivity_class = ANY($14::text[])
    AND d.authority = ANY($15::text[])
    AND d.status = 'active'
    AND d.revoked_at IS NULL
    AND NOT d.tombstoned
    AND NOT d.injection_blocked
    AND (d.valid_during IS NULL OR d.valid_during @> $4::timestamptz)
    AND d.recorded_during @> $7::timestamptz
), semantic AS (
  SELECT d.memory_version_id AS id,
         row_number() OVER (ORDER BY e.embedding <=> $1::vector) AS r
  FROM eligible d JOIN memory_embeddings e USING (memory_version_id)
  WHERE e.embedding_model_id = $5
  ORDER BY e.embedding <=> $1::vector LIMIT 50
), lexical AS (
  SELECT memory_version_id AS id,
         row_number() OVER (ORDER BY ts_rank_cd(
           search_tsv, websearch_to_tsquery('english', $6)) DESC) AS r
  FROM eligible
  WHERE search_tsv @@ websearch_to_tsquery('english', $6)
  ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('english', $6)) DESC LIMIT 50
), fused AS (
  SELECT id, sum(part) AS rrf FROM (
    SELECT id, 0.60 / (60 + r) FROM semantic
    UNION ALL SELECT id, 0.40 / (60 + r) FROM lexical
  ) lanes(id, part) GROUP BY id
)
SELECT d.*, fused.rrf FROM fused
JOIN eligible d ON d.memory_version_id = fused.id
ORDER BY fused.rrf DESC LIMIT 30;
```
The `0.60/0.40`, `60`, lane limits, and final limit are **proposed starting points**. If vectors are disabled, run lexical and trigram lanes and fuse those ranks. Under selective filters, pgvector 0.8.1 supports iterative scans to avoid returning too few eligible ANN results ([pgvector 0.8.1, 2025-09-05](https://github.com/pgvector/pgvector/releases/tag/v0.8.1)). Use exact scans when the scoped set is small enough.
### 3.5 Rerank for relevance, freshness, authority, and risk
After fusion, compute transparent features and optionally run a local cross-encoder on a small pool.
> **Synthesis / starting formula, not a published standard:**  
> `score = RRF + α·importance + β·temporal_fit + γ·bounded_usage + η·authority − δ·risk`

Where:
- `importance` is explicit and bounded;
- `temporal_fit` depends on query intent and memory kind;
- `bounded_usage` uses capped or logarithmic reinforcement;
- `authority` reflects origin and approval, not fluent wording;
- `risk` covers contradiction, staleness, low confidence, untrusted origin, and near-expiry.

LUFY demonstrates workload-specific combinations of semantic similarity, importance, recency, and retrieval history; it does not establish universal weights ([LUFY, 2025-12](https://aclanthology.org/2025.dnd-16.12/)). Mem0's documented decay uses a bounded multiplicative factor so old strong matches can still surface; this is vendor-reported practice, not a standard ([Mem0 memory decay, 2026-05-08](https://mem0.ai/blog/introducing-memory-decay-in-mem0)).

Use an open-source local cross-encoder only after cheap high-recall retrieval, typically on a few dozen candidates. MemReranker reports that generic rerankers struggle with temporal constraints, causal questions, and dialogue coreference; its gains are a new model-family result rather than broad independent replication ([MemReranker, 2026-05-07](https://arxiv.org/abs/2605.06132)).

Conditional reranking is enough for ambiguous, temporal, multi-hop, or consequential queries. Simple exact lookups should not pay model latency.
### 3.6 Kind-specific freshness and conflict handling
Do not apply one global recency decay:

| Memory kind | Freshness policy |
|---|---|
| Active decision | Validity and supersession dominate; no generic decay while active |
| Security/permission constraint | Authority and explicit revocation dominate |
| User preference | Long or no half-life; explicit correction wins |
| Deployment/location/current state | Short half-life plus `valid_during` and observation time |
| Procedure | Outcome-weighted utility; decay only when environment/version changes |
| Episode | Recency is a soft relevance feature, not truth |
| Third-party assertion | Source authority and corroboration dominate arrival time |

For kinds whose utility genuinely decays, a proposed soft feature is:
\[
freshness(age)=e^{-\ln(2)\cdot age/half\_life(kind)}
\]
Half-lives are application parameters. Temporal retrieval guidance favors intent-aware soft reranking because hard date filters can discard imprecisely dated but useful records ([Mem0 temporal reasoning, 2026-05-12](https://mem0.ai/blog/introducing-temporal-reasoning-in-mem0)). Hard validity exclusions remain appropriate when an item is explicitly expired or revoked.

When records conflict:
1. collapse exact duplicates;
2. follow supersession lineage;
3. exclude revoked/tombstoned items from current-state queries;
4. rank authority, temporal fit, evidence quality, corroboration, and confidence;
5. return competing assertions explicitly when no policy determines a winner;
6. never let recency silently override higher authority.
### 3.7 Iterative and relation-aware recall
One-shot top-*k* is weak for “why,” “what changed,” causal, and multi-hop questions. A-MEM links evolving notes, while HippoRAG 2 combines passages, graph structure, and Personalized PageRank and reports benchmark gains over its embedding baseline ([A-MEM, 2025-02-17](https://arxiv.org/abs/2502.12110); [HippoRAG 2, 2025-02-20](https://arxiv.org/abs/2502.14802)). These are paper-reported results, not a requirement for a separate graph database.

PostgreSQL can support a graph-lite path:
```text
memory_edges(from_id, to_id, relation_type, valid_during, authority, source_event_id)
```
Use bounded recursive CTEs or precomputed neighborhoods; cap depth, rows, and time. An agentic loop may retrieve, identify one evidence gap, rewrite the query or follow a relation, retrieve once more, then stop or abstain. Memory-R1 and AgeMem support treating retrieval as an explicit policy action ([Memory-R1, 2025-08-27](https://arxiv.org/abs/2508.19828); [AgeMem, 2026-01-05](https://arxiv.org/abs/2601.01885)).
### 3.8 Sufficiency and abstention
Similarity means related, not sufficient. After reranking, classify the evidence bundle as sufficient or insufficient. The Sufficient Context study reports that combining context sufficiency with model confidence improved selective accuracy at matched coverage in its evaluations ([Sufficient Context, 2024-11-09 / ICLR 2025](https://arxiv.org/abs/2411.06037)).

If insufficient:
1. issue at most one bounded rewritten or expanded search;
2. fetch referenced evidence by ID if available;
3. otherwise return an explicit memory miss or qualify the answer.

Calibrate thresholds per model and corpus. Cosine, `ts_rank_cd`, and RRF values are not confidence probabilities. Never pad the result to a fixed *k* with weak memories.
### 3.9 Context and token hygiene
Prompt bloat is an accuracy problem, not merely a cost problem. Chroma reports increasingly unreliable behavior as context grows and focused evidence outperforming full histories on LongMemEval comparisons ([Chroma Context Rot, 2025-07-14](https://www.trychroma.com/research/context-rot)). A controlled EMNLP study reports performance degradation from length even when required evidence remained retrievable ([Context Length Alone Hurts, 2025-11](https://aclanthology.org/2025.findings-emnlp.1264/)). ACL 2025 work also finds that irrelevant passages differ in how distracting they are ([The Distracting Effect, 2025-07](https://aclanthology.org/2025.acl-long.892/)).

Retrieval quality and hard-distractor removal matter more than universal position tricks. An EMNLP 2025 study found that position-based reordering did not reliably beat random shuffling in its realistic retrieval setup ([Positional Bias in RAG, 2025-11](https://aclanthology.org/2025.emnlp-main.1422/)). Test ordering with the actual model and workload.

Inject structured evidence, not raw rows or trace dumps:
```yaml
memory_context:
  - id: dec_42
    type: decision
    summary: Use PostgreSQL as the sole persistence, index, queue, and retrieval system for the memory subsystem.
    status: active
    valid_from: 2026-08-01
    supersedes: dec_17
    authority: approved
    source: architecture-review/2026-08-01
  - id: fact_91
    type: project_state
    summary: Current local embedding model is ...
    observed_at: ...
    confidence: ...
```
Each item should expose stable ID, type, compact summary, event/valid time, status, source, authority, confidence, and supersession where relevant. Retrieved text is reference data, never executable instruction.

Use both item and token/character caps. There is no universal optimum. Claude Code's bounded memory and Anthropic's compact subagent summaries are product patterns, not constants ([Claude Code memory docs, current 2026-08-15](https://code.claude.com/docs/en/memory); [Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
> **Synthesis / initial budget:** inject roughly 3–8 items and 800–1,500 memory tokens, expanding only after a sufficiency check. Tune against evidence recall, distractor rate, answer quality, latency, and abstention.
>
> Manage may retain a 1,000–4,000-token consolidated profile or another larger artifact. That storage budget is not an injection budget: Read selects a task-relevant subset and still enforces the per-turn item and 800–1,500-token projection caps.
Before packing:
- remove duplicates and superseded versions;
- diversify near-identical episodes;
- prefer concise summaries with expandable IDs;
- keep the best evidence in one clearly delimited block near the task;
- exclude recalled blocks from subsequent write extraction;
- avoid replaying old recalled context as if it were a new observation.
### 3.10 Security, isolation, and failure semantics
Memory poisoning can persist across turns. MINJA demonstrates query-only memory injection ([MINJA, 2025-03-05](https://arxiv.org/abs/2503.03704)). MemLineage proposes signed provenance and derivation lineage and reports strong results on its tested workloads, but those results are benchmark-bounded ([MemLineage, 2026-05-14](https://arxiv.org/abs/2605.14421)).

Read-time controls must therefore:
- enforce row scope before all ranking;
- preserve immutable origin and derivation metadata;
- distinguish user claims, tool observations, model interpretations, and approved decisions;
- re-check content against current injection policy;
- prevent untrusted memories from authorizing consequential tools;
- log candidate IDs, score components, rejected IDs/reasons, and injected IDs;
- cap SQL time, candidate rows, reranker time, traversal depth, and returned characters.

**Failure rule:** reads fail open for conversational availability—on timeout or database/model failure, continue without memory and surface degraded-memory status when useful. “Fail open” never means broadening tenant filters, accepting partial authorization, or using stale cache as authority. Security-boundary uncertainty fails closed; optional recall failure falls back to no memory.
### 3.11 Compact PostgreSQL read model
```sql
CREATE TABLE recall_documents (
  memory_version_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL, profile_id uuid, user_id uuid, project_id uuid,
  task_id uuid, agent_id uuid,
  visibility text NOT NULL, acl_principal_ids uuid[] NOT NULL,
  sensitivity_class text NOT NULL,
  memory_type text NOT NULL, summary text NOT NULL, search_tsv tsvector NOT NULL,
  importance real NOT NULL, confidence real, authority text NOT NULL,
  valid_during tstzrange, recorded_during tstzrange NOT NULL,
  status text NOT NULL, supersedes_memory_version_id uuid, observed_at timestamptz,
  tombstoned boolean NOT NULL DEFAULT false, revoked_at timestamptz,
  injection_blocked boolean NOT NULL DEFAULT false,
  last_accessed_at timestamptz, access_count bigint NOT NULL DEFAULT 0,
  provenance jsonb NOT NULL
);

CREATE INDEX recall_scope_idx
  ON recall_documents
    (tenant_id, profile_id, user_id, project_id, task_id, agent_id, memory_type, status);
CREATE INDEX recall_acl_idx ON recall_documents USING gin (acl_principal_ids);
CREATE INDEX recall_fts_idx ON recall_documents USING gin (search_tsv);
CREATE INDEX recall_valid_idx ON recall_documents USING gist (valid_during);
CREATE INDEX recall_recorded_idx ON recall_documents USING gist (recorded_during);
```
`recall_documents.memory_version_id` is a one-to-one read projection of `memory_versions.memory_version_id`, not a second authority. Stage 7 commits the canonical version, provenance, and its projection atomically; if projection construction fails, the new version does not become recall-visible.

Optional local embeddings remain separate:
```sql
CREATE TABLE memory_embeddings (
  memory_version_id uuid REFERENCES recall_documents,
  embedding_model_id text NOT NULL,
  embedding vector(1024) NOT NULL,
  PRIMARY KEY (memory_version_id, embedding_model_id)
);
CREATE INDEX memory_embedding_hnsw
  ON memory_embeddings USING hnsw (embedding vector_cosine_ops);
```
Native PostgreSQL FTS supports generated or maintained `tsvector` columns, GIN indexes, and ranked matching when the query uses the same text-search configuration ([PostgreSQL 18 full-text search, 2025-09-25](https://www.postgresql.org/docs/18/textsearch-tables.html)). This table contract admits only embedding models that produce exactly 1,024 dimensions; ingestion must reject an incompatible `embedding_model_id`. Supporting another dimension requires a separate dimension-specific embedding table and HNSW index. HNSW remains optional and is justified by measured latency/recall rather than fashion.
### 3.12 End-to-end recall algorithm
```text
1. Skip automatic recall for trivial acknowledgements or explicit no-memory mode.
2. Bind identity, scope, requested time, and authority policy.
3. Fetch active decisions and commitments by exact indexed fields.
4. Generate 30–50 general candidates across enabled PostgreSQL lanes.
5. Fuse ranks with weighted RRF.
6. Add kind-specific temporal, importance, usage, authority, and risk features.
7. Remove revoked/superseded records unless history was requested.
8. Optionally cross-encode difficult queries with a local open-source model.
9. Deduplicate, diversify, and run a sufficiency check.
10. Pack the highest-value evidence under item and token/character budgets.
11. If insufficient, perform one bounded retry; otherwise abstain.
12. Log the retrieval decision without recursively storing injected context.
```
### 3.13 Evaluation and phased adoption
Evaluate READ separately from generation:
- candidate Recall@k and required-evidence recall;
- precision and hard-distractor rate among injected items;
- decision hit rate and incorrect-decision influence;
- temporal correctness for current, historical, and superseded facts;
- sufficiency and abstention calibration;
- downstream task success against no-memory and prior-policy controls;
- injected tokens/characters and context share;
- SQL, embedding, reranking, and retry latency;
- cross-scope leakage and poisoning persistence;
- degraded-mode availability during PostgreSQL or model failure.

LongMemEval supports separating retrieval from final reading quality, while context-length studies show that higher recall alone is insufficient ([LongMemEval, 2024-10-14](https://arxiv.org/abs/2410.10813); [Context Length Alone Hurts, 2025-11](https://aclanthology.org/2025.findings-emnlp.1264/)). Build a labeled replay set from real tasks and treat every default weight, half-life, threshold, and budget as a hypothesis.

Adopt in stages:
1. **Auditable baseline:** decisions-first SQL, native FTS, `pg_trgm`, strict scope/validity filters, compact evidence blocks, explicit misses.
2. **Semantic quality:** local open-source embeddings in `pgvector`, weighted RRF, exact search first and HNSW only when measured.
3. **Precision:** kind-specific freshness, local reranker, sufficiency gate, one bounded iterative retrieval.
4. **Governance:** provenance verification, revocation replay, poisoning tests, and consequence-aware authorization.

The read phase succeeds by returning the **smallest trustworthy evidence set sufficient for the current task**, not by maximizing the number of remembered tokens.

---

## Sources

All sources below were published, submitted, or released on or after 2024-08-01. Dates are publication, first-submission, documentation-release, or software-release dates as indicated.

### Sources cited in the Write section

- [Microsoft — “Manage AI memory safety in agentic systems” (2026-06-03)](https://learn.microsoft.com/en-us/security/zero-trust/sfi/manage-agentic-memory-safety)
- [OpenAI — “New tools for building agents” (2025-03-11)](https://openai.com/index/new-tools-for-building-agents/)
- [LangChain — “LangMem SDK for agent long-term memory” (2025-02-18)](https://www.langchain.com/blog/langmem-sdk-launch)
- [Wang et al. — “Agent Workflow Memory” (ICML 2025 proceedings, 2025-10-06)](https://proceedings.mlr.press/v267/wang25bx.html)
- [Zhang et al. — “Memp: Exploring Agent Procedural Memory” (2025-08-08)](https://arxiv.org/abs/2508.06433)
- [Ouyang et al. — “ReasoningBank” (2025-09-29)](https://arxiv.org/abs/2509.25140)
- [Xu et al. — “A-MEM: Agentic Memory for LLM Agents” (2025-02-17)](https://arxiv.org/abs/2502.12110)
- [Dong et al. — “Memory Injection Attacks on LLM Agents via Query-Only Interaction” / MINJA (2025-03-05)](https://arxiv.org/abs/2503.03704)
- [PostgreSQL 18 — `SELECT` locking clause (release 2025-09-25)](https://www.postgresql.org/docs/18/sql-select.html)
- [PostgreSQL 18 — `pg_trgm` (release 2025-09-25)](https://www.postgresql.org/docs/18/pgtrgm.html)
- [Xiong et al. — “How Memory Management Impacts LLM Agents” (2025-05-21)](https://arxiv.org/abs/2505.16067)
- [Ma, Nan, and Wu — “What Deserves Memory” / NEMORI (ACL 2026-07)](https://aclanthology.org/2026.acl-long.1607/)
- [Rasmussen et al. — “Zep: A Temporal Knowledge Graph Architecture for Agent Memory” (2025-01-20)](https://arxiv.org/abs/2501.13956)
- [Rasmussen et al. — Zep/Graphiti HTML paper (2025-01-20)](https://arxiv.org/html/2501.13956v1)
- [Yan et al. — “Memory-R1” (2025-08-27)](https://arxiv.org/abs/2508.19828)
- [Mem0 — migration guide for the ADD-only memory algorithm (2026-04-14)](https://docs.mem0.ai/migration/oss-v2-to-v3)
- [Mem0 — `mem0ai` 2.0.0 package release (2026-04-16)](https://pypi.org/project/mem0ai/2.0.0/)
- [pgvector — “pgvector 0.8.0 Released!” (2024-11-11)](https://www.postgresql.org/about/news/pgvector-080-released-2952/)
- [PostgreSQL 18 — range types (release 2025-09-25)](https://www.postgresql.org/docs/18/rangetypes.html)
- [PostgreSQL 18 — JSON types (release 2025-09-25)](https://www.postgresql.org/docs/18/datatype-json.html)
- [citusdata — `pg_cron` v1.6.6 (2025-09-04)](https://github.com/citusdata/pg_cron/releases/tag/v1.6.6)
- [PostgreSQL 18 — row security policies (release 2025-09-25)](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)

### Sources cited in the Read section

- [Wu et al. — “LongMemEval” (2024-10-14)](https://arxiv.org/abs/2410.10813)
- [Anthropic — “How Claude remembers your project” (documentation current 2026-08-15)](https://code.claude.com/docs/en/memory)
- [Anthropic — Claude Code v2.1.59 (2026-02-26)](https://github.com/anthropics/claude-code/releases/tag/v2.1.59)
- [Anthropic — “Effective context engineering for AI agents” (2025-09-29)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Letta — “Agent Memory: How to Build Agents That Learn and Remember” (2025-07-07)](https://www.letta.com/blog/agent-memory/)
- [LangChain — “LangMem SDK for agent long-term memory” (2025-02-18)](https://www.langchain.com/blog/langmem-sdk-launch)
- [Yan et al. — “Memory-R1” (2025-08-27)](https://arxiv.org/abs/2508.19828)
- [Yu et al. — “Agentic Memory” / AgeMem (2026-01-05)](https://arxiv.org/abs/2601.01885)
- [Mem0 — “Memory Retrieval Strategies for AI Agents” (2026-05-11)](https://mem0.ai/blog/memory-retrieval-strategies-for-ai-agents)
- [Zep — Graphiti v0.29.3 (2026-07-27)](https://github.com/getzep/graphiti/releases/tag/v0.29.3)
- [Zep — Graphiti `search_config_recipes.py` (current implementation)](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_config_recipes.py)
- [ParadeDB — “Hybrid Search in PostgreSQL: The Missing Manual” (2025-10-22)](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual)
- [pgvector — v0.8.1 (2025-09-05)](https://github.com/pgvector/pgvector/releases/tag/v0.8.1)
- [Sumida, Inoue, and Kawahara — LUFY (2025-12)](https://aclanthology.org/2025.dnd-16.12/)
- [Mem0 — “Introducing Memory Decay in Mem0” (2026-05-08)](https://mem0.ai/blog/introducing-memory-decay-in-mem0)
- [Li et al. — “MemReranker” (2026-05-07)](https://arxiv.org/abs/2605.06132)
- [Mem0 — “Introducing Temporal Reasoning in Mem0” (2026-05-12)](https://mem0.ai/blog/introducing-temporal-reasoning-in-mem0)
- [Xu et al. — “A-MEM” (2025-02-17)](https://arxiv.org/abs/2502.12110)
- [Gutierrez et al. — “HippoRAG 2” (2025-02-20)](https://arxiv.org/abs/2502.14802)
- [Joren et al. — “Sufficient Context” (2024-11-09; ICLR 2025)](https://arxiv.org/abs/2411.06037)
- [Chroma — “Context Rot” (2025-07-14)](https://www.trychroma.com/research/context-rot)
- [Du et al. — “Context Length Alone Hurts LLM Performance Despite Perfect Retrieval” (EMNLP 2025-11)](https://aclanthology.org/2025.findings-emnlp.1264/)
- [Amiraz et al. — “The Distracting Effect” (ACL 2025-07)](https://aclanthology.org/2025.acl-long.892/)
- [Cuconasu et al. — “Do RAG Systems Really Suffer From Positional Bias?” (EMNLP 2025-11)](https://aclanthology.org/2025.emnlp-main.1422/)
- [Dong et al. — MINJA (2025-03-05)](https://arxiv.org/abs/2503.03704)
- [Ouyang et al. — “MemLineage” (2026-05-14)](https://arxiv.org/abs/2605.14421)
- [PostgreSQL 18 — full-text search tables and indexes (release 2025-09-25)](https://www.postgresql.org/docs/18/textsearch-tables.html)
