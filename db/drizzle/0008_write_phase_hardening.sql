CREATE TABLE "agent_review_receipts" (
	"agent_id" uuid NOT NULL,
	"review_key" text NOT NULL,
	"extractor_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_review_receipts_agent_id_review_key_extractor_id_pk" PRIMARY KEY("agent_id","review_key","extractor_id")
);
--> statement-breakpoint
ALTER TABLE "agent_outcomes" ADD COLUMN "sensitivity_class" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_outcomes" ADD COLUMN "injection_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_outcomes" ADD CONSTRAINT "agent_outcomes_sensitivity_check" CHECK ("agent_outcomes"."sensitivity_class" in ('normal', 'sensitive', 'restricted'));