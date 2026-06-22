# Dreaming + Self-Improvement: a Postgres integration design for this app

> Do OpenClaw's **Dreaming** memory-consolidation feature and Hermes' **Self-Improvement** stack conflict, supplement each other, or work together — and how should we wire Dreaming into *this* app, which already runs the Hermes half on Postgres?
>
> Decisions baked in (from the user): **(1) storage is Postgres/Drizzle, not markdown files; (2) on the one real conflict we favor the Hermes model** (many bounded writers governed by provenance + a single admission boundary, *not* Dreaming's single-writer gate).
>
> Produced in collaboration with the OpenAI Codex CLI (GPT-5.5, two read-only passes — the second one read this repo's own self-improvement code). Codex's corrections are folded in and attributed. Source guides: `/Users/season/Personal/openclaw/DREAMING_IMPLEMENTATION_GUIDE.md`, `/Users/season/Personal/hermes-agent/SELF_IMPROVEMENT_IMPLEMENTATION_GUIDE.md`.

---

## TL;DR

- **Conflict?** Only one real one — *memory-admission authority* (who may write durable memory). We resolve it the **Hermes way**: many bounded writers through one admission boundary. Dreaming becomes a **consolidation proposer**, not the gatekeeper.
- **Supplement?** Strongly. They occupy different niches and each one's known weakness is the other's design purpose.
- **Mix?** Yes. The serialization conflict from the file-based world **disappears** on Postgres (row-per-fact, not a `§`-delimited file). What's left is governance + a hard provenance firewall.
- **This app already implements the Hermes half** in Postgres. **Dreaming is the missing consolidation layer.** This doc is the plan to add it.

The mental model: **Self-improvement is the whole house; Dreaming is one appliance** — a statistical consolidation engine that plugs into the declarative-memory slot.

---

## What this app already has (the Hermes half, in Postgres)

From `db/schema.ts` + `lib/self-improvement/`:

| Built | Table / file | Maps to Hermes |
|---|---|---|
| Declarative memory | `agent_memories` — `kind`(preference/fact/correction/persona), `content`(≤2000), **`source`(user/review/curated)**, `confidence`, **`status`(approved/archived)**, partial index `agent_memories_prompt_idx` WHERE approved | `MEMORY.md`/`USER.md` + provenance + soft-archive |
| Procedural memory | `agent_skills` — skill/reference parent-child, `is_enabled`, **soft-delete via `deleted_at`** (no hard delete) | skills + recoverable archive |
| **Admission boundary** | `agent_review_proposals` — `kind`(memory_*/skill_*), `payload`, `rationale`, `status`(pending/rejected/applied/failed), `reviewer_model` | the proposal-gated write path |
| Cadence counter | `agent_review_states` — `turns_since_memory_review` per session | Loop A's `_turns_since_memory` |
| Grounded corpus | `agent_chat_messages` (parts jsonb), `agent_chat_sessions` | the transcripts |
| Cron | `agent_scheduled_tasks` / pg-boss | the scheduler |

**Missing (all of Dreaming):** the evidence/recall tier, phase signals, the weighted scoring + gates, the consolidation sweep, and a grounded-observations firewall. Also missing: the curator's time-based staleness transitions, and external recall (Loop C).

---

## How the two features differ

| Axis | Dreaming (OpenClaw) | Self-Improvement (Hermes) |
|---|---|---|
| **Trigger** | Wall-clock cron | Loop A: event (every N turns) · Loop B: idle interval · Loop C: per-turn |
| **Decision** | Deterministic weighted score + gates — **no LLM in the decision** | Loop A: **LLM judgment** · Loop B: deterministic + optional LLM |
| **Scope** | Declarative facts **only** | Declarative facts **+ skills + external recall** |
| **Latency to durable** | Days (evidence must accrue) | Immediate (right after the turn) |
| **Bias** | **Precision** — prevent over-promotion | **Recall** — "doing nothing is a missed opportunity" |
| **Writer model** | **Exactly one** (Deep) behind gates | **Many bounded writers** by provenance/dispatch |
| **LLM cost** | ~0 in the decision path | One forked review per cadence hit |

**Why they are genuinely complementary (not just non-overlapping):** Loop A's documented eagerness *is* the over-promotion failure Dreaming was built to control; Dreaming's slowness and fact-only scope *is* exactly Loop A's strength (one-shot explicit corrections, skills). Fast judgment-based capture **feeds** slow statistical consolidation. This is the **complementary-learning-systems** split (see Biology, below). Skills (Hermes Loop B) are pure addition — Dreaming has no procedural story at all.

---

## The one real conflict, resolved the Hermes way

**Memory-admission authority.** Dreaming's safety proof is *"only Deep writes durable memory, behind deterministic gates."* Hermes explicitly rejects one-writer-per-class and allows many writers bounded by provenance/dispatch. These are opposite governance models — a genuine architectural conflict **if they co-own one store.**

We pick Hermes. Therefore:

- **There is one admission boundary: the `agent_review_proposals` → apply pipeline.** Every durable write (foreground tool, Loop A review, curator, Dreaming) goes through it.
- **Dreaming is one proposer among several, not the gate.** Its Deep phase scores candidates and emits proposals; it does not write `agent_memories` directly.
- Governance = **provenance + admission policy**, enforced at the boundary, not "one privileged writer."

> The file-world's *second* conflict — colliding serialization formats + a file drift-guard — **does not exist here.** `agent_memories` is row-per-fact. Dreaming's "compact oldest auto-promotions" becomes `status='archived'` on the oldest `source='consolidated'` rows; it never touches `source='user'`. No file, no marker blocks, no drift guard. Transactions + row locks replace the file lock.

---

## The Postgres integration design (grounded in the real schema)

Codex read this repo and flagged that the naive version is **too trusting**. The corrected design:

### 1. A physical grounded-evidence tier (the firewall is a table, not a `WHERE` clause)

A `source`-column filter is **necessary but not sufficient** — a CHECK can't prove another table's row is user-authored, and derivative text leaks in many ways (see failure mode). So make the firewall structural:

- **`agent_grounded_observations`** — written **only** by an ingestion service, with a closed origin set: `user_message`, `user_memory` (i.e. `agent_memories.source='user'`), maybe `trusted_tool_result`. **Never** assistant turns, system messages, scheduled-task output, proposal `payload`/`rationale`, or provider mirrors.
- **`agent_recall_signals`** (the evidence/counter tier) references `grounded_observation_id` — **not** an arbitrary `agent_chat_messages` row (whose identity is `(session_id, id)`, not globally unique, and which includes assistant/system roles). *"Transcript" ≠ "grounded evidence."*
- **`agent_phase_signals`** (`light_hits`, `rem_hits`, …) may **reorder or add a small bounded boost only**. Phase hits must **never** satisfy the count/diversity gates on their own — gates require fresh *grounded* observations. (This is the cross-system version of Dreaming's own "never score your own output.")
- **`agent_ingestion_checkpoints`** for incremental ingestion.

### 2. Dreaming proposes through the admission ledger — but doesn't flood it

- Keep **raw statistical candidates in Dreaming's own tables.** Emit only **post-gate, deduped, top-N, batched** rows into `agent_review_proposals`. The proposals table is the **admission ledger**, not the raw candidate queue.
- The `source` enum and apply path need real work — adding `'consolidated'` is **not** a one-liner:
  - `validation.ts:10` allows only `user|review|curated`; `apply.ts:78` **hard-codes `source:"review"`** on memory creates.
  - Add an explicit **`proposer_origin` / `admission_policy`** on the proposal — do **not** overload `reviewer_model='dreaming'`.
- **Auto-apply policy** (and call it what it is — a silent durable writer, which is fine *if explicit and auditable*):
  - Auto-apply only `source='consolidated'`, low-risk `kind='fact'` rows.
  - Require: high score **+** multiple distinct days **+** multiple grounded observations **+** no conflict with an approved memory **+** successful rehydrate-at-apply.
  - **Manual queue** for preferences, persona, corrections, conflicts, low evidence, or anything touching `source='user'`.
  - Record `auto_policy_version`, the score components, the evidence IDs, and the scorer version on each admission.

### 3. Durable-side dedupe

Add `claim_hash` (normalized) **on the durable side**, not just on recall signals — otherwise Loop A and Dreaming create parallel rows of the same fact. Conflict-detect before creating a proposal; a partial-unique guard on live approved normalized claims is better.

### 4. Fix the two-state snapshot (currently absent)

Today memory is **re-queried every chat POST** (`inject.ts` → `listApprovedMemories`, called in `route.ts:252`) — so a mid-session write would change the injected block on the next request. That violates Hermes' frozen-snapshot/cache-stability invariant. Fix:

- Add **`agent_memory_snapshots(session_id, rendered_block, memory_ids, source_counts, created_at)`**; materialize it once at session start and read *that* for the session's lifetime. Live writes mutate rows + show in tool responses but never the frozen block; refresh next session.
- Threat-scan/sanitize at render time; keep raw row text for user inspection.

### 5. Other Postgres/Drizzle gotchas (Codex)

- **Apply races:** current apply serializes only by proposal id (advisory lock) — that stops double-click, not two proposals racing on the same target memory or duplicate-claim creates. Add **row locks on target memories** + the claim-hash guard.
- **Provenance link:** `review_proposal_id ON DELETE SET NULL` is fine only if proposals are disposable. If proposals are the audit trail, keep them (restrict deletion) or a consolidated memory loses its provenance.
- **pgvector:** use it for *retrieval*, never *authority*. Counts, distinct days, claim hashes, and provenance decide promotion. Store embedding model/version; keep similarity out of "unique evidence."
- **Dreaming jobs:** run on a **dedicated internal pg-boss queue / hidden task type with singleton keys** — the existing user-facing queue is `stately` and keyless jobs can swallow each other.

---

## The #1 failure mode (and why the firewall must be hard)

**Authority/provenance collapse → manufactured certainty.** If LLM-authored derivative text is ever re-ingested as first-order evidence, you get an amplifying loop:

> Loop A writes a plausible memory → Dreaming ingests it → scores it → phase-boost reinforces it → external recall echoes it back → the system fabricates confidence in its own invention.

Favoring Hermes (Dreaming is *not* the single gate) **reintroduces this risk** unless the evidence firewall is a hard structural invariant. Concrete sneak-paths Codex named:

- Assistant turns that paraphrase an injected memory.
- Scheduled-task outputs (assistant-generated artifacts).
- Persisted system messages.
- Proposal `payload`/`rationale` if any later ingestion scans JSON/log tables.
- External-recall mirrors returning consolidated memories as if they were observations.
- A user *quoting* the assistant — only the user's endorsement is grounded, not the quoted claim.

The defense: the **`agent_grounded_observations` table + ingestion service** (closed origin set), recall signals referencing only grounded observation IDs, and phase hits that can't satisfy gates alone.

---

## Biology: REM sleep, short-term memory, long-term memory

The user asked directly. Here's the real relationship, then how faithfully Dreaming's `Light → REM → Deep` naming maps. (My take, cross-checked with Codex — we agree.)

**The science:**
- **Working / short-term memory** — volatile, capacity-limited, active firing in prefrontal/parietal cortex + hippocampal binding; seconds to minutes.
- **Long-term memory** forms via **synaptic consolidation** (minutes–hours, stabilize the trace) then **systems consolidation** (days–years, hippocampus-dependent memories migrate into distributed neocortex). **Sleep drives systems consolidation.**
- **Deep / slow-wave (NREM) sleep** — the hippocampus *replays* the day's episodic traces (sharp-wave ripples coupled to slow oscillations + spindles), transferring **declarative** memories to neocortical long-term storage.
- **REM sleep** — *integration*: gist/abstraction, schema-building, novel association, and emotional processing ("overnight therapy"). When vivid dreaming happens.
- **Synaptic homeostasis (SHY)** — sleep also *downscales/prunes* weak synapses to restore signal-to-noise. Keep the strong, drop the noise.
- **Complementary Learning Systems (CLS)** — a **fast-learning hippocampus** + a **slow-learning neocortex**; sleep replay lets the fast store teach the slow store offline. *This is exactly the fast-capture (Hermes Loop A) + slow-consolidation (Dreaming) split.*

**Mapping:**

| Biology | System analog |
|---|---|
| Working / short-term memory | The **session context** (injected memory block + live transcript): bounded, ephemeral |
| Hippocampal-indexed episodic buffer | **`agent_recall_signals`** (evidence tier) + Loop A's fast per-turn capture — *not* literal short-term memory |
| Neocortical slow store | **`agent_memories` (approved) + `agent_skills`** — durable, surfaced into future sessions |
| SWS replay → declarative transfer | **Dreaming's Deep phase** (promote well-evidenced facts) |
| REM integration / gist | **Dreaming's REM phase** (themes + candidate truths) |
| Synaptic downscaling/pruning | **Eviction/compaction** (retention cap; soft-archive oldest `consolidated`) + curator staleness |

**Where the analogy is APT:** the two-tier store + offline consolidation genuinely mirrors CLS and the two-stage model; **Deep ≈ slow-wave declarative consolidation** is well-named; **REM ≈ integration/abstraction** is reasonable; pruning ≈ synaptic homeostasis.

**Where it's LOOSE or backwards (Codex + me):**
- Real sleep **cycles NREM → REM repeatedly** (~90-min cycles), with **deep slow-wave sleep early/heavier and REM later/heavier**. So `Light → REM → Deep` *once-through, REM-before-Deep* is biologically **backwards** if Deep means SWS consolidation. Dreaming's order is an engineering pipeline (REM marks reinforcement that Deep then consumes), not a faithful sleep architecture.
- REM is **not** "preprocessing before a durable write" in a simple pipeline — NREM replay and REM integration interact cyclically.
- The **hippocampus is not just short-term RAM** — it holds long-lived episodic traces while neocortex slowly integrates semantic structure.
- No analog for REM's **emotional-memory** role; "Light sleep = intake" is loose (N2 spindles actually do consolidation work); phase-hit "voting" is an engineering device, not a real REM mechanism.

**Bottom line:** the biology is a useful *motivation*, not a *model*. Codex's framing, which I endorse: keep the computational order if it works, but read the phases as **`Ingest → Abstract → Consolidate`** and state plainly that the sleep names are an engineering metaphor. The guide itself agrees: *"It is not a model capability; it is a scheduled data pipeline."* (Nice irony: Hermes *rejects* the sleep metaphor, yet its own Loop A + curator still instantiate CLS — the pattern is convergent, not branding.)

---

## When you'd run just one

Substitutes only on the *declarative-memory* axis:

- **Self-improvement only** — you need procedural skill evolution, immediate explicit-preference capture, and prompt-cache discipline. The pragmatic baseline (and what this app already is). Evidence-gating also **starves at low volume** — nothing reaches the count/diversity gates — so Dreaming adds little until traffic is high.
- **Dreaming only** — you need conservative, auditable, *deterministic* declarative consolidation from many weak signals, zero LLM in the commit decision, and you distrust LLM judgment writing durable memory.

> **Verdict:** complements in a mature agent; substitutes in a small system where *"what becomes durable prompt memory?"* must have exactly one answer.

---

## Open decisions before building

1. **Auto-apply vs. always-queue** for Dreaming proposals (recommended: narrow auto-apply for `consolidated` facts, queue everything else).
2. Whether to build the **two-state snapshot** now (fixes a real cache-stability gap) or defer until Dreaming lands.
3. Whether external recall (Loop C) is in scope at all — it's orthogonal and can wait.
4. Keep the `Light/REM/Deep` names (with the metaphor caveat) or rename to `Ingest/Abstract/Consolidate`.

---

## What the Codex collaboration changed (this round)

Codex read the app's own code and corrected the design where I was too trusting:
1. The app does **not** have a frozen two-state snapshot — it re-queries memory per POST (`inject.ts`/`route.ts:252`). *(Verified.)*
2. Adding `source='consolidated'` is not enough — `apply.ts:78` hard-codes `source:"review"` and `validation.ts:10` whitelists only three values; needs an explicit `proposer_origin`/`admission_policy`. *(Verified.)*
3. The provenance firewall must be a **physical grounded-observations table**, not a `source` `WHERE` clause — and listed the concrete sneak-paths.
4. Dreaming should use the proposal table as an **admission ledger**, emitting deduped post-gate batches, with an explicit (and honestly-labeled) auto-apply policy — not dump raw candidates into the human queue.
5. Concrete Postgres gotchas: durable-side `claim_hash` dedupe, apply-race row locking, provenance-link retention, pgvector-as-retrieval-not-authority, singleton internal pg-boss queue.
6. Biology: confirmed the mapping is "directionally useful but loose," and that `Light→REM→Deep` once-through is biologically backwards.
