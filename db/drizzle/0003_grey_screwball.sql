CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"session_id" uuid,
	"review_proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_memories_kind_check" CHECK ("agent_memories"."kind" in ('preference', 'fact', 'correction', 'persona')),
	CONSTRAINT "agent_memories_source_check" CHECK ("agent_memories"."source" in ('user', 'review', 'curated')),
	CONSTRAINT "agent_memories_status_check" CHECK ("agent_memories"."status" in ('approved', 'archived')),
	CONSTRAINT "agent_memories_content_check" CHECK (char_length("agent_memories"."content") between 1 and 2000),
	CONSTRAINT "agent_memories_confidence_check" CHECK ("agent_memories"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "agent_review_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"session_id" uuid,
	"trigger_message_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_model" text,
	"applied_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_review_proposals_kind_check" CHECK ("agent_review_proposals"."kind" in ('memory_create', 'memory_edit', 'memory_archive', 'skill_create', 'skill_edit', 'skill_toggle')),
	CONSTRAINT "agent_review_proposals_status_check" CHECK ("agent_review_proposals"."status" in ('pending', 'rejected', 'applied', 'failed')),
	CONSTRAINT "agent_review_proposals_rationale_check" CHECK (char_length("agent_review_proposals"."rationale") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "agent_review_states" (
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"session_id" uuid NOT NULL,
	"turns_since_memory_review" integer DEFAULT 0 NOT NULL,
	"last_reviewed_message_id" text,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_review_states_agent_id_session_id_pk" PRIMARY KEY("agent_id","session_id"),
	CONSTRAINT "agent_review_states_turns_check" CHECK ("agent_review_states"."turns_since_memory_review" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_review_proposal_id_agent_review_proposals_id_fk" FOREIGN KEY ("review_proposal_id") REFERENCES "public"."agent_review_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_proposals" ADD CONSTRAINT "agent_review_proposals_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_states" ADD CONSTRAINT "agent_review_states_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memories_prompt_idx" ON "agent_memories" USING btree ("agent_id","kind","created_at") WHERE "agent_memories"."status" = 'approved' and "agent_memories"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "agent_review_proposals_pending_idx" ON "agent_review_proposals" USING btree ("agent_id","created_at") WHERE "agent_review_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_review_proposals_session_idx" ON "agent_review_proposals" USING btree ("session_id","created_at");