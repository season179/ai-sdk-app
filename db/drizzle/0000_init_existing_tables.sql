-- Baseline migration. These tables already exist on deployed databases (built
-- by the legacy db/migrations/*.sql), so every statement is guarded to be a
-- no-op when the object is already present. That lets `pnpm db:migrate` run
-- cleanly against BOTH a fresh database (creates everything) and an existing
-- one (creates nothing). Future schema changes get plain, unguarded migrations
-- from `pnpm db:generate`.
CREATE TABLE IF NOT EXISTS "agent_scheduled_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"pg_boss_job_id" uuid NOT NULL,
	"status" text NOT NULL,
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_scheduled_task_runs_pg_boss_job_id_key" UNIQUE("pg_boss_job_id"),
	CONSTRAINT "agent_scheduled_task_runs_status_check" CHECK ("agent_scheduled_task_runs"."status" in ('running', 'completed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_scheduled_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"schedule_type" text NOT NULL,
	"run_at" timestamp with time zone,
	"cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" text NOT NULL,
	"queue_name" text NOT NULL,
	"schedule_key" text,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_scheduled_tasks_schedule_type_check" CHECK ("agent_scheduled_tasks"."schedule_type" in ('once', 'cron')),
	CONSTRAINT "agent_scheduled_tasks_status_check" CHECK ("agent_scheduled_tasks"."status" in ('active', 'paused', 'completed', 'cancelled')),
	CONSTRAINT "agent_scheduled_tasks_check" CHECK (("agent_scheduled_tasks"."schedule_type" = 'once' and "agent_scheduled_tasks"."run_at" is not null) or ("agent_scheduled_tasks"."schedule_type" = 'cron' and "agent_scheduled_tasks"."cron" is not null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"parent_id" uuid,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "agent_skills_type_check" CHECK ("agent_skills"."type" in ('skill', 'reference')),
	CONSTRAINT "agent_skills_name_check" CHECK (char_length("agent_skills"."name") between 1 and 64),
	CONSTRAINT "agent_skills_description_check" CHECK (char_length("agent_skills"."description") between 1 and 1024),
	CONSTRAINT "agent_skills_parent_shape" CHECK (("agent_skills"."type" = 'skill' and "agent_skills"."parent_id" is null) or ("agent_skills"."type" = 'reference' and "agent_skills"."parent_id" is not null))
);
--> statement-breakpoint
-- Each table carries exactly one FK; add it only when no FK exists yet, so an
-- existing database keeps its original "_fkey" constraint instead of gaining a
-- duplicate under drizzle's "_fk" name.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_scheduled_task_runs'::regclass AND contype = 'f') THEN
		ALTER TABLE "agent_scheduled_task_runs" ADD CONSTRAINT "agent_scheduled_task_runs_task_id_agent_scheduled_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_scheduled_tasks"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_skills'::regclass AND contype = 'f') THEN
		ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_parent_id_agent_skills_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."agent_skills"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_scheduled_task_runs_task_id_idx" ON "agent_scheduled_task_runs" USING btree ("task_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_skill_name_uniq" ON "agent_skills" USING btree ("agent_id","name") WHERE "agent_skills"."type" = 'skill' and "agent_skills"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_reference_name_uniq" ON "agent_skills" USING btree ("parent_id","name") WHERE "agent_skills"."type" = 'reference' and "agent_skills"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skills_catalog_idx" ON "agent_skills" USING btree ("agent_id") WHERE "agent_skills"."type" = 'skill' and "agent_skills"."is_enabled" = true and "agent_skills"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skills_parent_idx" ON "agent_skills" USING btree ("parent_id") WHERE "agent_skills"."deleted_at" is null;
