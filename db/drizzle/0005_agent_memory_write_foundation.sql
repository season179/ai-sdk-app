CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "agent_decision_trace_events" (
	"decision_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_role" text NOT NULL,
	CONSTRAINT "agent_decision_trace_events_decision_id_event_id_pk" PRIMARY KEY("decision_id","event_id"),
	CONSTRAINT "agent_decision_trace_events_role_check" CHECK ("agent_decision_trace_events"."source_role" in ('context', 'declaration', 'criterion'))
);
--> statement-breakpoint
CREATE TABLE "agent_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"session_id" uuid,
	"task_id" uuid,
	"trace_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"subject_key" text NOT NULL,
	"selected_option" text NOT NULL,
	"declared_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"declared_rationale" text NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_outcome" text,
	"success_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" integer NOT NULL,
	"status" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_during" "tstzrange",
	"recorded_during" "tstzrange" NOT NULL,
	"decider" text NOT NULL,
	"model_id" text,
	"prompt_hash" text,
	"policy_version" text NOT NULL,
	"authority" text NOT NULL,
	"sensitivity_class" text DEFAULT 'normal' NOT NULL,
	"revoked_at" timestamp with time zone,
	"tombstoned" boolean DEFAULT false NOT NULL,
	"injection_blocked" boolean DEFAULT false NOT NULL,
	"supersedes_decision_id" uuid,
	CONSTRAINT "agent_decisions_scope_check" CHECK ("agent_decisions"."scope_type" in ('agent', 'session', 'task')),
	CONSTRAINT "agent_decisions_rationale_check" CHECK (char_length("agent_decisions"."declared_rationale") between 1 and 2000),
	CONSTRAINT "agent_decisions_confidence_check" CHECK ("agent_decisions"."confidence" between 0 and 100),
	CONSTRAINT "agent_decisions_status_check" CHECK ("agent_decisions"."status" in ('open', 'succeeded', 'failed', 'mixed', 'superseded', 'unknown')),
	CONSTRAINT "agent_decisions_authority_check" CHECK ("agent_decisions"."authority" in ('user', 'worker', 'model_verdict', 'reviewed', 'legacy_import')),
	CONSTRAINT "agent_decisions_sensitivity_check" CHECK ("agent_decisions"."sensitivity_class" in ('normal', 'sensitive', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "agent_memory_candidate_trace_events" (
	"candidate_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_role" text NOT NULL,
	"source_span" jsonb,
	CONSTRAINT "agent_memory_candidate_trace_events_candidate_id_event_id_pk" PRIMARY KEY("candidate_id","event_id"),
	CONSTRAINT "agent_memory_candidate_trace_events_role_check" CHECK ("agent_memory_candidate_trace_events"."source_role" in ('primary', 'corroborating', 'context'))
);
--> statement-breakpoint
CREATE TABLE "agent_memory_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"review_key" text NOT NULL,
	"trace_id" text NOT NULL,
	"memory_type" text NOT NULL,
	"canonical_key" text,
	"content" text,
	"structured" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_stance" text NOT NULL,
	"valid_during" "tstzrange",
	"source_reference_time" timestamp with time zone,
	"time_precision" text DEFAULT 'unknown' NOT NULL,
	"confidence" integer NOT NULL,
	"proposed_operation" text NOT NULL,
	"gate_status" text NOT NULL,
	"gate_reason" text NOT NULL,
	"score_bps" integer NOT NULL,
	"content_hash" text NOT NULL,
	"extractor_id" text NOT NULL,
	"model_id" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"schema_version" integer NOT NULL,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_candidates_extract_uniq" UNIQUE("agent_id","review_key","extractor_id","content_hash"),
	CONSTRAINT "agent_memory_candidates_memory_type_check" CHECK ("agent_memory_candidates"."memory_type" in ('semantic', 'episodic', 'procedural')),
	CONSTRAINT "agent_memory_candidates_source_stance_check" CHECK ("agent_memory_candidates"."source_stance" in ('observation', 'assertion', 'interpretation', 'evaluation')),
	CONSTRAINT "agent_memory_candidates_time_precision_check" CHECK ("agent_memory_candidates"."time_precision" in ('instant', 'day', 'month', 'year', 'unknown')),
	CONSTRAINT "agent_memory_candidates_confidence_check" CHECK ("agent_memory_candidates"."confidence" between 0 and 100),
	CONSTRAINT "agent_memory_candidates_operation_check" CHECK ("agent_memory_candidates"."proposed_operation" in ('ADD', 'UPDATE', 'INVALIDATE', 'NOOP', 'REVIEW')),
	CONSTRAINT "agent_memory_candidates_gate_status_check" CHECK ("agent_memory_candidates"."gate_status" in ('accepted', 'rejected', 'quarantined')),
	CONSTRAINT "agent_memory_candidates_score_check" CHECK ("agent_memory_candidates"."score_bps" between 0 and 10000),
	CONSTRAINT "agent_memory_candidates_content_shape_check" CHECK (("agent_memory_candidates"."gate_status" = 'accepted' and char_length("agent_memory_candidates"."content") between 1 and 2000) or ("agent_memory_candidates"."gate_status" in ('rejected', 'quarantined') and "agent_memory_candidates"."content" is null))
);
--> statement-breakpoint
CREATE TABLE "agent_memory_version_trace_events" (
	"memory_version_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_role" text NOT NULL,
	"source_span" jsonb,
	CONSTRAINT "agent_memory_version_trace_events_memory_version_id_event_id_pk" PRIMARY KEY("memory_version_id","event_id"),
	CONSTRAINT "agent_memory_version_trace_events_role_check" CHECK ("agent_memory_version_trace_events"."source_role" in ('primary', 'corroborating', 'context'))
);
--> statement-breakpoint
CREATE TABLE "agent_memory_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"content" text NOT NULL,
	"structured" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"valid_during" "tstzrange",
	"recorded_during" "tstzrange" NOT NULL,
	"source_reference_time" timestamp with time zone,
	"time_precision" text DEFAULT 'unknown' NOT NULL,
	"time_source" text,
	"observed_at" timestamp with time zone,
	"last_confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"confidence" integer NOT NULL,
	"importance" integer DEFAULT 50 NOT NULL,
	"utility_score_bps" integer DEFAULT 0 NOT NULL,
	"operation" text NOT NULL,
	"supersedes_memory_version_id" uuid,
	"extractor_id" text,
	"model_id" text,
	"prompt_hash" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"policy_version" text NOT NULL,
	"authority" text NOT NULL,
	"sensitivity_class" text DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED,
	CONSTRAINT "agent_memory_versions_memory_version_uniq" UNIQUE("memory_id","version_no"),
	CONSTRAINT "agent_memory_versions_version_check" CHECK ("agent_memory_versions"."version_no" >= 1),
	CONSTRAINT "agent_memory_versions_content_check" CHECK (char_length("agent_memory_versions"."content") between 1 and 2000),
	CONSTRAINT "agent_memory_versions_source_check" CHECK ("agent_memory_versions"."source" in ('user', 'review', 'curated', 'consolidated')),
	CONSTRAINT "agent_memory_versions_time_precision_check" CHECK ("agent_memory_versions"."time_precision" in ('instant', 'day', 'month', 'year', 'unknown')),
	CONSTRAINT "agent_memory_versions_confidence_check" CHECK ("agent_memory_versions"."confidence" between 0 and 100),
	CONSTRAINT "agent_memory_versions_importance_check" CHECK ("agent_memory_versions"."importance" between 0 and 100),
	CONSTRAINT "agent_memory_versions_utility_score_check" CHECK ("agent_memory_versions"."utility_score_bps" between 0 and 10000),
	CONSTRAINT "agent_memory_versions_operation_check" CHECK ("agent_memory_versions"."operation" in ('ADD', 'UPDATE', 'INVALIDATE')),
	CONSTRAINT "agent_memory_versions_authority_check" CHECK ("agent_memory_versions"."authority" in ('user', 'tool', 'reviewed', 'consolidated', 'legacy_import')),
	CONSTRAINT "agent_memory_versions_sensitivity_check" CHECK ("agent_memory_versions"."sensitivity_class" in ('normal', 'sensitive', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "agent_outcome_trace_events" (
	"outcome_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_role" text NOT NULL,
	CONSTRAINT "agent_outcome_trace_events_outcome_id_event_id_pk" PRIMARY KEY("outcome_id","event_id"),
	CONSTRAINT "agent_outcome_trace_events_role_check" CHECK ("agent_outcome_trace_events"."source_role" in ('observation', 'metric', 'terminal_state'))
);
--> statement-breakpoint
CREATE TABLE "agent_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"observed_state" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assessment" text NOT NULL,
	"confidence" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluator" text NOT NULL,
	"evaluator_version" text,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_outcomes_observed_state_check" CHECK (char_length("agent_outcomes"."observed_state") between 1 and 4000),
	CONSTRAINT "agent_outcomes_assessment_check" CHECK ("agent_outcomes"."assessment" in ('supports', 'contradicts', 'inconclusive')),
	CONSTRAINT "agent_outcomes_confidence_check" CHECK ("agent_outcomes"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "agent_trace_artifacts" (
	"artifact_hash" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"encoding" text,
	"redacted_excerpt" text NOT NULL,
	"content" "bytea",
	"sensitivity_class" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "agent_trace_artifacts_hash_check" CHECK ("agent_trace_artifacts"."artifact_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_trace_artifacts_byte_size_check" CHECK ("agent_trace_artifacts"."byte_size" >= 0),
	CONSTRAINT "agent_trace_artifacts_excerpt_check" CHECK (char_length("agent_trace_artifacts"."redacted_excerpt") <= 4000),
	CONSTRAINT "agent_trace_artifacts_content_check" CHECK ("agent_trace_artifacts"."content" is null or octet_length("agent_trace_artifacts"."content") <= 262144),
	CONSTRAINT "agent_trace_artifacts_sensitivity_check" CHECK ("agent_trace_artifacts"."sensitivity_class" in ('normal', 'sensitive', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "agent_trace_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"trace_id" text NOT NULL,
	"sequence_no" integer NOT NULL,
	"span_id" text,
	"parent_event_id" uuid,
	"session_id" uuid,
	"task_id" uuid,
	"pg_boss_job_id" uuid,
	"source_message_id" text,
	"tool_call_id" text,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"trust_class" text NOT NULL,
	"sensitivity_class" text DEFAULT 'normal' NOT NULL,
	"terminal_status" text,
	"payload" jsonb NOT NULL,
	"artifact_hash" text,
	"content_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"retention_class" text NOT NULL,
	"policy_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "agent_trace_events_agent_idempotency_key" UNIQUE("agent_id","idempotency_key"),
	CONSTRAINT "agent_trace_events_sequence_check" CHECK ("agent_trace_events"."sequence_no" >= 0),
	CONSTRAINT "agent_trace_events_event_type_check" CHECK ("agent_trace_events"."event_type" in ('user_message', 'assistant_message', 'model_generation', 'tool_requested', 'tool_result', 'environment_observation', 'guardrail_result', 'feedback', 'decision_declared', 'outcome_observed', 'task_terminal_state', 'explicit_memory_write', 'legacy_import')),
	CONSTRAINT "agent_trace_events_actor_check" CHECK ("agent_trace_events"."actor" in ('user', 'assistant', 'tool', 'system', 'scheduler', 'worker')),
	CONSTRAINT "agent_trace_events_trust_check" CHECK ("agent_trace_events"."trust_class" in ('user_assertion', 'tool_observation', 'third_party_content', 'model_inference', 'evaluator_result', 'system_record')),
	CONSTRAINT "agent_trace_events_sensitivity_check" CHECK ("agent_trace_events"."sensitivity_class" in ('normal', 'sensitive', 'restricted')),
	CONSTRAINT "agent_trace_events_terminal_status_check" CHECK ("agent_trace_events"."terminal_status" is null or "agent_trace_events"."terminal_status" in ('completed', 'failed', 'interrupted', 'skipped')),
	CONSTRAINT "agent_trace_events_terminal_shape_check" CHECK (("agent_trace_events"."event_type" = 'task_terminal_state' and "agent_trace_events"."terminal_status" is not null) or ("agent_trace_events"."event_type" <> 'task_terminal_state' and "agent_trace_events"."terminal_status" is null)),
	CONSTRAINT "agent_trace_events_payload_check" CHECK (octet_length("agent_trace_events"."payload"::text) <= 65536),
	CONSTRAINT "agent_trace_events_idempotency_key_check" CHECK (char_length("agent_trace_events"."idempotency_key") between 1 and 256),
	CONSTRAINT "agent_trace_events_retention_check" CHECK ("agent_trace_events"."retention_class" in ('short', 'standard', 'audit'))
);
--> statement-breakpoint
ALTER TABLE "agent_consolidation_runs" DROP CONSTRAINT "agent_consolidation_runs_trigger_check";--> statement-breakpoint
ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_kind_check";--> statement-breakpoint
ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_status_check";--> statement-breakpoint
ALTER TABLE "agent_consolidation_candidates" ADD COLUMN "candidate_origin" text DEFAULT 'signal' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_consolidation_candidates" ADD COLUMN "source_candidate_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_consolidation_candidates" ADD COLUMN "memory_type" text;--> statement-breakpoint
ALTER TABLE "agent_grounded_observations" ADD COLUMN "trace_event_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "memory_type" text DEFAULT 'semantic' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "canonical_key" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "conflict_policy" text DEFAULT 'append_temporal' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "scope_type" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "scope_id" text DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "tombstoned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "injection_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory_events" ADD COLUMN "memory_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_review_proposals" ADD COLUMN "source_candidate_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_decision_trace_events" ADD CONSTRAINT "agent_decision_trace_events_decision_id_agent_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."agent_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_decision_trace_events" ADD CONSTRAINT "agent_decision_trace_events_event_id_agent_trace_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_supersedes_decision_id_agent_decisions_id_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "public"."agent_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_candidate_trace_events" ADD CONSTRAINT "agent_memory_candidate_trace_events_candidate_id_agent_memory_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."agent_memory_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_candidate_trace_events" ADD CONSTRAINT "agent_memory_candidate_trace_events_event_id_agent_trace_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_version_trace_events" ADD CONSTRAINT "agent_memory_version_trace_events_memory_version_id_agent_memory_versions_id_fk" FOREIGN KEY ("memory_version_id") REFERENCES "public"."agent_memory_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_version_trace_events" ADD CONSTRAINT "agent_memory_version_trace_events_event_id_agent_trace_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_versions" ADD CONSTRAINT "agent_memory_versions_memory_id_agent_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."agent_memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_versions" ADD CONSTRAINT "agent_memory_versions_supersedes_memory_version_id_agent_memory_versions_id_fk" FOREIGN KEY ("supersedes_memory_version_id") REFERENCES "public"."agent_memory_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outcome_trace_events" ADD CONSTRAINT "agent_outcome_trace_events_outcome_id_agent_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."agent_outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outcome_trace_events" ADD CONSTRAINT "agent_outcome_trace_events_event_id_agent_trace_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outcomes" ADD CONSTRAINT "agent_outcomes_decision_id_agent_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."agent_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_parent_event_id_agent_trace_events_id_fk" FOREIGN KEY ("parent_event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_artifact_hash_agent_trace_artifacts_artifact_hash_fk" FOREIGN KEY ("artifact_hash") REFERENCES "public"."agent_trace_artifacts"("artifact_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_decision_trace_events_event_idx" ON "agent_decision_trace_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_decisions_supersedes_uniq" ON "agent_decisions" USING btree ("supersedes_decision_id") WHERE "agent_decisions"."supersedes_decision_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_decisions_active_subject_idx" ON "agent_decisions" USING btree ("agent_id","scope_type","scope_id","subject_key","status","decided_at" DESC NULLS LAST) WHERE "agent_decisions"."status" <> 'superseded' and "agent_decisions"."revoked_at" is null and "agent_decisions"."tombstoned" = false and "agent_decisions"."injection_blocked" = false;--> statement-breakpoint
CREATE INDEX "agent_decisions_task_status_idx" ON "agent_decisions" USING btree ("task_id","status","decided_at" DESC NULLS LAST) WHERE "agent_decisions"."task_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_decisions_valid_during_idx" ON "agent_decisions" USING gist ("valid_during");--> statement-breakpoint
CREATE INDEX "agent_decisions_recorded_during_idx" ON "agent_decisions" USING gist ("recorded_during");--> statement-breakpoint
CREATE INDEX "agent_memory_candidate_trace_events_event_idx" ON "agent_memory_candidate_trace_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "agent_memory_candidates_gate_created_idx" ON "agent_memory_candidates" USING btree ("agent_id","gate_status","created_at");--> statement-breakpoint
CREATE INDEX "agent_memory_candidates_canonical_key_idx" ON "agent_memory_candidates" USING btree ("agent_id","canonical_key") WHERE "agent_memory_candidates"."canonical_key" is not null;--> statement-breakpoint
CREATE INDEX "agent_memory_version_trace_events_event_idx" ON "agent_memory_version_trace_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_versions_supersedes_uniq" ON "agent_memory_versions" USING btree ("supersedes_memory_version_id") WHERE "agent_memory_versions"."supersedes_memory_version_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_memory_versions_search_tsv_idx" ON "agent_memory_versions" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "agent_memory_versions_content_trgm_idx" ON "agent_memory_versions" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agent_memory_versions_valid_during_idx" ON "agent_memory_versions" USING gist ("valid_during");--> statement-breakpoint
CREATE INDEX "agent_memory_versions_recorded_during_idx" ON "agent_memory_versions" USING gist ("recorded_during");--> statement-breakpoint
CREATE INDEX "agent_memory_versions_memory_version_idx" ON "agent_memory_versions" USING btree ("memory_id","version_no" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_memory_versions_expires_idx" ON "agent_memory_versions" USING btree ("expires_at") WHERE "agent_memory_versions"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "agent_outcome_trace_events_event_idx" ON "agent_outcome_trace_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "agent_outcomes_decision_occurred_idx" ON "agent_outcomes" USING btree ("decision_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_outcomes_trace_occurred_idx" ON "agent_outcomes" USING btree ("trace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_trace_artifacts_expires_idx" ON "agent_trace_artifacts" USING btree ("expires_at") WHERE "agent_trace_artifacts"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "agent_trace_events_trace_sequence_idx" ON "agent_trace_events" USING btree ("agent_id","trace_id","sequence_no");--> statement-breakpoint
CREATE INDEX "agent_trace_events_session_ingested_idx" ON "agent_trace_events" USING btree ("session_id","ingested_at") WHERE "agent_trace_events"."session_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_trace_events_task_job_ingested_idx" ON "agent_trace_events" USING btree ("task_id","pg_boss_job_id","ingested_at") WHERE "agent_trace_events"."task_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_trace_events_type_occurred_idx" ON "agent_trace_events" USING btree ("agent_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_trace_events_expires_idx" ON "agent_trace_events" USING btree ("expires_at") WHERE "agent_trace_events"."expires_at" is not null;--> statement-breakpoint
ALTER TABLE "agent_consolidation_candidates" ADD CONSTRAINT "agent_consolidation_candidates_source_candidate_id_agent_memory_candidates_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."agent_memory_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grounded_observations" ADD CONSTRAINT "agent_grounded_observations_trace_event_id_agent_trace_events_id_fk" FOREIGN KEY ("trace_event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_current_version_id_agent_memory_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."agent_memory_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_events" ADD CONSTRAINT "agent_memory_events_memory_version_id_agent_memory_versions_id_fk" FOREIGN KEY ("memory_version_id") REFERENCES "public"."agent_memory_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_proposals" ADD CONSTRAINT "agent_review_proposals_source_candidate_id_agent_memory_candidates_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."agent_memory_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_consolidation_candidates_source_candidate_uniq" ON "agent_consolidation_candidates" USING btree ("source_candidate_id") WHERE "agent_consolidation_candidates"."source_candidate_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_grounded_observations_trace_event_idx" ON "agent_grounded_observations" USING btree ("trace_event_id");--> statement-breakpoint
CREATE INDEX "agent_memories_active_current_idx" ON "agent_memories" USING btree ("agent_id","scope_type","scope_id","memory_type","kind","status") WHERE "agent_memories"."status" not in ('creating', 'archived') and "agent_memories"."revoked_at" is null and "agent_memories"."tombstoned" = false and "agent_memories"."injection_blocked" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memories_canonical_key_uniq" ON "agent_memories" USING btree ("agent_id","scope_type","scope_id","memory_type","canonical_key") WHERE "agent_memories"."canonical_key" is not null and "agent_memories"."status" not in ('creating', 'archived') and "agent_memories"."revoked_at" is null and "agent_memories"."tombstoned" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_review_proposals_source_candidate_uniq" ON "agent_review_proposals" USING btree ("source_candidate_id") WHERE "agent_review_proposals"."source_candidate_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_consolidation_candidates" ADD CONSTRAINT "agent_consolidation_candidates_origin_check" CHECK ("agent_consolidation_candidates"."candidate_origin" in ('signal', 'turn_review'));--> statement-breakpoint
ALTER TABLE "agent_consolidation_candidates" ADD CONSTRAINT "agent_consolidation_candidates_memory_type_check" CHECK ("agent_consolidation_candidates"."memory_type" is null or "agent_consolidation_candidates"."memory_type" in ('semantic', 'episodic', 'procedural'));--> statement-breakpoint
ALTER TABLE "agent_consolidation_runs" ADD CONSTRAINT "agent_consolidation_runs_trigger_check" CHECK ("agent_consolidation_runs"."trigger" in ('scheduled', 'manual', 'turn_review'));--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_memory_type_check" CHECK ("agent_memories"."memory_type" in ('semantic', 'episodic', 'procedural'));--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_conflict_policy_check" CHECK ("agent_memories"."conflict_policy" in ('replace_current', 'append_temporal', 'add_only', 'version_evaluate'));--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_scope_type_check" CHECK ("agent_memories"."scope_type" in ('agent', 'session', 'task'));--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_tombstone_shape_check" CHECK (("agent_memories"."tombstoned" = true and "agent_memories"."tombstoned_at" is not null) or ("agent_memories"."tombstoned" = false and "agent_memories"."tombstoned_at" is null));--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_kind_check" CHECK ("agent_memories"."kind" in ('preference', 'fact', 'correction', 'persona', 'episode', 'procedure'));--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_status_check" CHECK ("agent_memories"."status" in ('creating', 'approved', 'archived'));
--> statement-breakpoint

-- Deterministic migration import: preserve every existing user-only grounded
-- observation as bounded trace evidence without widening the firewall.
INSERT INTO "agent_trace_events" (
  "agent_id", "trace_id", "sequence_no", "source_message_id", "event_type",
  "actor", "trust_class", "sensitivity_class", "payload", "content_hash",
  "idempotency_key", "retention_class", "policy_version", "occurred_at"
)
SELECT
  o."agent_id",
  'legacy-observation:' || o."id"::text,
  0,
  o."source_message_id",
  'legacy_import',
  'system',
  'user_assertion',
  'normal',
  jsonb_build_object(
    'originKind', o."origin_kind",
    'sessionId', o."session_id",
    'sourceMessageId', o."source_message_id",
    'sourceMemoryId', o."source_memory_id",
    'content', o."content"
  ),
  o."content_hash",
  'legacy-observation:' || o."id"::text,
  'audit',
  'legacy-import-v1',
  o."created_at"
FROM "agent_grounded_observations" o
ON CONFLICT ("agent_id", "idempotency_key") DO NOTHING;
--> statement-breakpoint

UPDATE "agent_grounded_observations" o
SET "trace_event_id" = e."id"
FROM "agent_trace_events" e
WHERE e."agent_id" = o."agent_id"
  AND e."idempotency_key" = 'legacy-observation:' || o."id"::text
  AND o."trace_event_id" IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_grounded_observations" WHERE "trace_event_id" IS NULL) THEN
    RAISE EXCEPTION 'legacy grounded-observation trace backfill left null provenance';
  END IF;
END $$;
--> statement-breakpoint

-- One audit event per legacy mutable memory head. The original source controls
-- the actor/trust classification; model-derived rows never become grounded
-- observations.
INSERT INTO "agent_trace_events" (
  "agent_id", "trace_id", "sequence_no", "session_id", "event_type", "actor",
  "trust_class", "sensitivity_class", "payload", "content_hash",
  "idempotency_key", "retention_class", "policy_version", "occurred_at"
)
SELECT
  m."agent_id",
  'legacy-memory:' || m."id"::text,
  0,
  m."session_id",
  'legacy_import',
  CASE WHEN m."source" = 'user' THEN 'user' ELSE 'system' END,
  CASE m."source"
    WHEN 'user' THEN 'user_assertion'
    WHEN 'review' THEN 'evaluator_result'
    WHEN 'consolidated' THEN 'model_inference'
    ELSE 'system_record'
  END,
  'normal',
  jsonb_build_object(
    'memoryId', m."id",
    'kind', m."kind",
    'source', m."source",
    'content', m."content"
  ),
  coalesce(m."claim_hash", md5(m."content")),
  'legacy-memory:' || m."id"::text,
  'audit',
  'legacy-import-v1',
  m."created_at"
FROM "agent_memories" m
ON CONFLICT ("agent_id", "idempotency_key") DO NOTHING;
--> statement-breakpoint

UPDATE "agent_memories"
SET
  "memory_type" = 'semantic',
  "conflict_policy" = CASE
    WHEN "kind" IN ('preference', 'persona', 'correction') THEN 'replace_current'
    ELSE 'append_temporal'
  END,
  "scope_type" = CASE WHEN "session_id" IS NULL THEN 'agent' ELSE 'session' END,
  "scope_id" = coalesce("session_id"::text, "agent_id"::text),
  "tombstoned" = "deleted_at" IS NOT NULL,
  "tombstoned_at" = "deleted_at";
--> statement-breakpoint

INSERT INTO "agent_memory_versions" (
  "memory_id", "version_no", "content", "structured", "source",
  "recorded_during", "confidence", "operation", "extractor_id",
  "schema_version", "policy_version", "authority", "sensitivity_class",
  "created_at"
)
SELECT
  m."id",
  1,
  m."content",
  '{}'::jsonb,
  m."source",
  tstzrange(m."created_at", NULL, '[)'),
  m."confidence",
  'ADD',
  'legacy-import-v1',
  1,
  'legacy-import-v1',
  'legacy_import',
  'normal',
  m."created_at"
FROM "agent_memories" m
ON CONFLICT ("memory_id", "version_no") DO NOTHING;
--> statement-breakpoint

INSERT INTO "agent_memory_version_trace_events" (
  "memory_version_id", "event_id", "source_role"
)
SELECT v."id", e."id", 'primary'
FROM "agent_memories" m
JOIN "agent_memory_versions" v
  ON v."memory_id" = m."id" AND v."version_no" = 1
JOIN "agent_trace_events" e
  ON e."agent_id" = m."agent_id"
 AND e."idempotency_key" = 'legacy-memory:' || m."id"::text
ON CONFLICT ("memory_version_id", "event_id") DO NOTHING;
--> statement-breakpoint

UPDATE "agent_memories" m
SET "current_version_id" = v."id"
FROM "agent_memory_versions" v
WHERE v."memory_id" = m."id"
  AND v."version_no" = 1
  AND m."current_version_id" IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_memories"
    WHERE "status" <> 'creating' AND "current_version_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy memory version backfill left a root without a current version';
  END IF;
END $$;