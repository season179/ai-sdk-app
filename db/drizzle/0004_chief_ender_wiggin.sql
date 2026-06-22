CREATE TABLE "agent_consolidation_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"claim_key" text NOT NULL,
	"snippet" text NOT NULL,
	"score_bps" integer NOT NULL,
	"gate_results" jsonb,
	"passed" boolean NOT NULL,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_consolidation_candidates_score_check" CHECK ("agent_consolidation_candidates"."score_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "agent_consolidation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"observations_scanned" integer DEFAULT 0 NOT NULL,
	"candidates_evaluated" integer DEFAULT 0 NOT NULL,
	"candidates_passed" integer DEFAULT 0 NOT NULL,
	"proposals_created" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "agent_consolidation_runs_status_check" CHECK ("agent_consolidation_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "agent_consolidation_runs_trigger_check" CHECK ("agent_consolidation_runs"."trigger" in ('scheduled', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "agent_consolidation_settings" (
	"agent_id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"auto_apply_enabled" boolean DEFAULT false NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"min_score_bps" integer DEFAULT 8000 NOT NULL,
	"min_recall_count" integer DEFAULT 3 NOT NULL,
	"min_unique_queries" integer DEFAULT 3 NOT NULL,
	"max_age_days" integer DEFAULT 30 NOT NULL,
	"weights" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "agent_consolidation_settings_min_score_check" CHECK ("agent_consolidation_settings"."min_score_bps" between 0 and 10000),
	CONSTRAINT "agent_consolidation_settings_min_recall_check" CHECK ("agent_consolidation_settings"."min_recall_count" >= 0),
	CONSTRAINT "agent_consolidation_settings_min_unique_queries_check" CHECK ("agent_consolidation_settings"."min_unique_queries" >= 0),
	CONSTRAINT "agent_consolidation_settings_max_age_check" CHECK ("agent_consolidation_settings"."max_age_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_grounded_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"session_id" uuid,
	"origin_kind" text NOT NULL,
	"source_message_id" text,
	"source_memory_id" uuid,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_grounded_observations_origin_kind_check" CHECK ("agent_grounded_observations"."origin_kind" in ('chat_user', 'memory_user')),
	CONSTRAINT "agent_grounded_observations_content_check" CHECK (char_length("agent_grounded_observations"."content") between 1 and 2000),
	CONSTRAINT "agent_grounded_observations_source_shape" CHECK (("agent_grounded_observations"."origin_kind" = 'chat_user' and "agent_grounded_observations"."session_id" is not null and "agent_grounded_observations"."source_message_id" is not null and "agent_grounded_observations"."source_memory_id" is null) or ("agent_grounded_observations"."origin_kind" = 'memory_user' and "agent_grounded_observations"."source_memory_id" is not null and "agent_grounded_observations"."source_message_id" is null))
);
--> statement-breakpoint
CREATE TABLE "agent_ingestion_checkpoints" (
	"agent_id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"last_chat_message_created_at" timestamp with time zone,
	"last_chat_session_id" uuid,
	"last_chat_message_id" text,
	"last_memory_created_at" timestamp with time zone,
	"last_memory_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"event_type" text NOT NULL,
	"memory_id" uuid,
	"proposal_id" uuid,
	"run_id" uuid,
	"origin" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_events_event_type_check" CHECK ("agent_memory_events"."event_type" in ('created', 'edited', 'archived', 'protected', 'unprotected', 'proposed', 'applied', 'rejected', 'consolidation_run')),
	CONSTRAINT "agent_memory_events_origin_check" CHECK ("agent_memory_events"."origin" in ('user', 'review', 'consolidation', 'curator'))
);
--> statement-breakpoint
CREATE TABLE "agent_memory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"session_id" uuid NOT NULL,
	"rendered_block" text NOT NULL,
	"memory_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_phase_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"claim_key" text NOT NULL,
	"light_hits" integer DEFAULT 0 NOT NULL,
	"rem_hits" integer DEFAULT 0 NOT NULL,
	"last_light_at" timestamp with time zone,
	"last_rem_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_phase_signals_light_hits_check" CHECK ("agent_phase_signals"."light_hits" >= 0),
	CONSTRAINT "agent_phase_signals_rem_hits_check" CHECK ("agent_phase_signals"."rem_hits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_recall_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"claim_key" text NOT NULL,
	"claim_hash" text NOT NULL,
	"snippet" text NOT NULL,
	"grounded_observation_ids" jsonb NOT NULL,
	"recall_count" integer DEFAULT 0 NOT NULL,
	"unique_query_count" integer DEFAULT 0 NOT NULL,
	"query_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recall_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"concept_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_score_bps" integer DEFAULT 0 NOT NULL,
	"max_score_bps" integer DEFAULT 0 NOT NULL,
	"first_recalled_at" timestamp with time zone,
	"last_recalled_at" timestamp with time zone,
	"promoted_at" timestamp with time zone,
	"promoted_proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_recall_signals_score_check" CHECK ("agent_recall_signals"."total_score_bps" between 0 and 10000),
	CONSTRAINT "agent_recall_signals_max_score_check" CHECK ("agent_recall_signals"."max_score_bps" between 0 and 10000),
	CONSTRAINT "agent_recall_signals_recall_count_check" CHECK ("agent_recall_signals"."recall_count" >= 0),
	CONSTRAINT "agent_recall_signals_unique_query_count_check" CHECK ("agent_recall_signals"."unique_query_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_source_check";--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "claim_hash" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "is_protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "protected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "protected_by" text;--> statement-breakpoint
ALTER TABLE "agent_review_proposals" ADD COLUMN "proposer_origin" text DEFAULT 'turn_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_review_proposals" ADD COLUMN "admission_policy" text DEFAULT 'human_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_review_proposals" ADD COLUMN "admission_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "agent_consolidation_candidates" ADD CONSTRAINT "agent_consolidation_candidates_run_id_agent_consolidation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_consolidation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grounded_observations" ADD CONSTRAINT "agent_grounded_observations_source_memory_id_agent_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."agent_memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_snapshots" ADD CONSTRAINT "agent_memory_snapshots_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_consolidation_candidates_run_idx" ON "agent_consolidation_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_consolidation_runs_agent_idx" ON "agent_consolidation_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grounded_observations_chat_uniq" ON "agent_grounded_observations" USING btree ("agent_id","session_id","source_message_id") WHERE "agent_grounded_observations"."origin_kind" = 'chat_user' and "agent_grounded_observations"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grounded_observations_memory_uniq" ON "agent_grounded_observations" USING btree ("agent_id","source_memory_id") WHERE "agent_grounded_observations"."origin_kind" = 'memory_user' and "agent_grounded_observations"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "agent_grounded_observations_agent_created_idx" ON "agent_grounded_observations" USING btree ("agent_id","created_at") WHERE "agent_grounded_observations"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "agent_memory_events_agent_created_idx" ON "agent_memory_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_memory_events_memory_idx" ON "agent_memory_events" USING btree ("memory_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_snapshots_session_uniq" ON "agent_memory_snapshots" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_phase_signals_claim_uniq" ON "agent_phase_signals" USING btree ("agent_id","claim_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_recall_signals_claim_uniq" ON "agent_recall_signals" USING btree ("agent_id","claim_hash");--> statement-breakpoint
CREATE INDEX "agent_recall_signals_agent_idx" ON "agent_recall_signals" USING btree ("agent_id","last_recalled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memories_claim_hash_uniq" ON "agent_memories" USING btree ("agent_id","kind","claim_hash") WHERE "agent_memories"."deleted_at" is null and "agent_memories"."claim_hash" is not null;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_check" CHECK ("agent_memories"."source" in ('user', 'review', 'curated', 'consolidated'));--> statement-breakpoint
ALTER TABLE "agent_review_proposals" ADD CONSTRAINT "agent_review_proposals_proposer_origin_check" CHECK ("agent_review_proposals"."proposer_origin" in ('manual', 'turn_review', 'consolidation', 'curator'));--> statement-breakpoint
ALTER TABLE "agent_review_proposals" ADD CONSTRAINT "agent_review_proposals_admission_policy_check" CHECK ("agent_review_proposals"."admission_policy" in ('human_review', 'auto_apply_low_risk', 'dry_run_only'));