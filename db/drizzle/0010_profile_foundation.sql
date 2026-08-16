CREATE TABLE "agent_profile_fact_tombstones" (
	"agent_id" uuid NOT NULL,
	"fact_key" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by" text NOT NULL,
	"reason" text,
	"explicit_trace_event_id" uuid NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	"retired_trace_event_id" uuid,
	CONSTRAINT "agent_profile_fact_tombstones_agent_id_fact_key_pk" PRIMARY KEY("agent_id","fact_key"),
	CONSTRAINT "agent_profile_fact_tombstones_retired_shape_check" CHECK (("agent_profile_fact_tombstones"."retired_at" is null and "agent_profile_fact_tombstones"."retired_by" is null and "agent_profile_fact_tombstones"."retired_trace_event_id" is null) or ("agent_profile_fact_tombstones"."retired_at" is not null and "agent_profile_fact_tombstones"."retired_by" is not null and "agent_profile_fact_tombstones"."retired_trace_event_id" is not null)),
	CONSTRAINT "agent_profile_fact_tombstones_fact_key_check" CHECK (char_length("agent_profile_fact_tombstones"."fact_key") between 1 and 200),
	CONSTRAINT "agent_profile_fact_tombstones_reason_check" CHECK ("agent_profile_fact_tombstones"."reason" is null or char_length("agent_profile_fact_tombstones"."reason") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "agent_profile_synthesis_receipts" (
	"agent_id" uuid NOT NULL,
	"synthesis_key" text NOT NULL,
	"synthesizer_id" text NOT NULL,
	"profile_version_id" uuid,
	"input_lower_bounds" jsonb NOT NULL,
	"input_upper_bounds" jsonb NOT NULL,
	"result" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profile_synthesis_receipts_agent_id_synthesis_key_synthesizer_id_pk" PRIMARY KEY("agent_id","synthesis_key","synthesizer_id"),
	CONSTRAINT "agent_profile_synthesis_receipts_result_check" CHECK ("agent_profile_synthesis_receipts"."result" in ('created', 'noop')),
	CONSTRAINT "agent_profile_synthesis_receipts_version_shape_check" CHECK (("agent_profile_synthesis_receipts"."result" = 'created' and "agent_profile_synthesis_receipts"."profile_version_id" is not null) or ("agent_profile_synthesis_receipts"."result" = 'noop' and "agent_profile_synthesis_receipts"."profile_version_id" is null))
);
--> statement-breakpoint
CREATE TABLE "agent_profile_version_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"fact_key" text NOT NULL,
	"trace_event_id" uuid,
	"memory_version_id" uuid,
	"source_role" text NOT NULL,
	CONSTRAINT "agent_profile_version_sources_shape_check" CHECK (("agent_profile_version_sources"."trace_event_id" is not null and "agent_profile_version_sources"."memory_version_id" is null) or ("agent_profile_version_sources"."trace_event_id" is null and "agent_profile_version_sources"."memory_version_id" is not null)),
	CONSTRAINT "agent_profile_version_sources_fact_key_check" CHECK (char_length("agent_profile_version_sources"."fact_key") between 1 and 200),
	CONSTRAINT "agent_profile_version_sources_role_check" CHECK ("agent_profile_version_sources"."source_role" in ('primary', 'corroborating', 'context'))
);
--> statement-breakpoint
CREATE TABLE "agent_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"body" text NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger" text NOT NULL,
	"authority" text NOT NULL,
	"char_count" integer GENERATED ALWAYS AS (char_length("body")) STORED,
	"token_count" integer NOT NULL,
	"recorded_during" "tstzrange" NOT NULL,
	"model_id" text,
	"prompt_hash" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_profile_version_id" uuid,
	CONSTRAINT "agent_profile_versions_agent_version_uniq" UNIQUE("agent_id","version_no"),
	CONSTRAINT "agent_profile_versions_version_check" CHECK ("agent_profile_versions"."version_no" >= 1),
	CONSTRAINT "agent_profile_versions_body_check" CHECK (char_length("agent_profile_versions"."body") <= 5000),
	CONSTRAINT "agent_profile_versions_facts_check" CHECK (jsonb_typeof("agent_profile_versions"."facts") = 'array'),
	CONSTRAINT "agent_profile_versions_trigger_check" CHECK ("agent_profile_versions"."trigger" in ('scheduled', 'explicit', 'manual_ui')),
	CONSTRAINT "agent_profile_versions_authority_check" CHECK ("agent_profile_versions"."authority" in ('synthesized', 'user')),
	CONSTRAINT "agent_profile_versions_token_count_check" CHECK ("agent_profile_versions"."token_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"agent_id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"current_version_id" uuid,
	"last_observation_created_at" timestamp with time zone,
	"last_observation_id" uuid,
	"last_memory_version_created_at" timestamp with time zone,
	"last_memory_version_id" uuid,
	"dirty_generation" integer DEFAULT 0 NOT NULL,
	"synthesized_generation" integer DEFAULT 0 NOT NULL,
	"last_synthesis_attempt_at" timestamp with time zone,
	"last_synthesized_at" timestamp with time zone,
	"last_synthesis_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_generations_check" CHECK ("agent_profiles"."dirty_generation" >= 0 and "agent_profiles"."synthesized_generation" >= 0 and "agent_profiles"."synthesized_generation" <= "agent_profiles"."dirty_generation"),
	CONSTRAINT "agent_profiles_error_check" CHECK ("agent_profiles"."last_synthesis_error" is null or char_length("agent_profiles"."last_synthesis_error") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ADD COLUMN "profile_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_profile_fact_tombstones" ADD CONSTRAINT "agent_profile_fact_tombstones_explicit_trace_event_id_agent_trace_events_id_fk" FOREIGN KEY ("explicit_trace_event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_fact_tombstones" ADD CONSTRAINT "agent_profile_fact_tombstones_retired_trace_event_id_agent_trace_events_id_fk" FOREIGN KEY ("retired_trace_event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_synthesis_receipts" ADD CONSTRAINT "agent_profile_synthesis_receipts_profile_version_id_agent_profile_versions_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."agent_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_version_sources" ADD CONSTRAINT "agent_profile_version_sources_profile_version_id_agent_profile_versions_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."agent_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_version_sources" ADD CONSTRAINT "agent_profile_version_sources_trace_event_id_agent_trace_events_id_fk" FOREIGN KEY ("trace_event_id") REFERENCES "public"."agent_trace_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_version_sources" ADD CONSTRAINT "agent_profile_version_sources_memory_version_id_agent_memory_versions_id_fk" FOREIGN KEY ("memory_version_id") REFERENCES "public"."agent_memory_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_versions" ADD CONSTRAINT "agent_profile_versions_supersedes_profile_version_id_agent_profile_versions_id_fk" FOREIGN KEY ("supersedes_profile_version_id") REFERENCES "public"."agent_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_current_version_id_agent_profile_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."agent_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_profile_fact_tombstones_active_idx" ON "agent_profile_fact_tombstones" USING btree ("agent_id","deleted_at") WHERE "agent_profile_fact_tombstones"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profile_version_sources_trace_uniq" ON "agent_profile_version_sources" USING btree ("profile_version_id","fact_key","trace_event_id") WHERE "agent_profile_version_sources"."trace_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profile_version_sources_memory_uniq" ON "agent_profile_version_sources" USING btree ("profile_version_id","fact_key","memory_version_id") WHERE "agent_profile_version_sources"."memory_version_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_profile_version_sources_trace_event_idx" ON "agent_profile_version_sources" USING btree ("trace_event_id");--> statement-breakpoint
CREATE INDEX "agent_profile_version_sources_memory_version_idx" ON "agent_profile_version_sources" USING btree ("memory_version_id");--> statement-breakpoint
CREATE INDEX "agent_profile_version_sources_fact_idx" ON "agent_profile_version_sources" USING btree ("profile_version_id","fact_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profile_versions_supersedes_uniq" ON "agent_profile_versions" USING btree ("supersedes_profile_version_id") WHERE "agent_profile_versions"."supersedes_profile_version_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_profile_versions_recorded_during_idx" ON "agent_profile_versions" USING gist ("recorded_during");--> statement-breakpoint
CREATE INDEX "agent_profile_versions_agent_version_idx" ON "agent_profile_versions" USING btree ("agent_id","version_no" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_profile_version_id_agent_profile_versions_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."agent_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_chat_messages_profile_version_idx" ON "agent_chat_messages" USING btree ("profile_version_id") WHERE "agent_chat_messages"."profile_version_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_chat_messages_time_search_idx" ON "agent_chat_messages" USING btree ("session_id","created_at","id");--> statement-breakpoint

-- Drizzle can express the top-level array CHECK above, but not a strict
-- per-element JSON manifest check. Keep malformed facts out of immutable
-- versions so later readers can trust ProfileFactV1 without coercion.
CREATE FUNCTION "agent_profile_facts_v1_valid"("value" jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  "fact" jsonb;
  "field_count" integer;
BEGIN
  IF jsonb_typeof("value") <> 'array' THEN
    RETURN false;
  END IF;

  FOR "fact" IN SELECT * FROM jsonb_array_elements("value")
  LOOP
    IF jsonb_typeof("fact") <> 'object' THEN
      RETURN false;
    END IF;

    SELECT count(*)::integer INTO "field_count" FROM jsonb_object_keys("fact");
    IF "field_count" <> 6 OR NOT ("fact" ?& ARRAY[
      'factKey', 'sentence', 'category', 'authority', 'protected', 'order'
    ]) THEN
      RETURN false;
    END IF;

    IF jsonb_typeof("fact"->'factKey') <> 'string'
      OR char_length("fact"->>'factKey') NOT BETWEEN 1 AND 200
      OR jsonb_typeof("fact"->'sentence') <> 'string'
      OR char_length("fact"->>'sentence') < 1
      OR jsonb_typeof("fact"->'category') <> 'string'
      OR ("fact"->>'category') NOT IN (
        'identity_context',
        'preferences_constraints',
        'active_projects_goals',
        'interaction_instructions'
      )
      OR jsonb_typeof("fact"->'authority') <> 'string'
      OR ("fact"->>'authority') NOT IN ('synthesized', 'user')
      OR jsonb_typeof("fact"->'protected') <> 'boolean'
      OR jsonb_typeof("fact"->'order') <> 'number'
    THEN
      RETURN false;
    END IF;

    IF ("fact"->>'order') !~ '^(0|[1-9][0-9]*)$' THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE "agent_profile_versions"
  ADD CONSTRAINT "agent_profile_versions_facts_v1_check"
  CHECK ("agent_profile_facts_v1_valid"("facts"));
--> statement-breakpoint

-- Cross-row fact provenance cannot be represented as a normal CHECK. Defer it
-- to transaction commit so a profile commit may insert version + sources and
-- move the head in any order while an incomplete version can never go current.
CREATE FUNCTION "agent_profile_validate_current_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  "active_version_id" uuid;
  "version_agent_id" uuid;
  "version_facts" jsonb;
BEGIN
  IF NEW."current_version_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."current_version_id" IS NOT DISTINCT FROM OLD."current_version_id" THEN
    RETURN NEW;
  END IF;

  SELECT "current_version_id"
    INTO "active_version_id"
    FROM "agent_profiles"
   WHERE "agent_id" = NEW."agent_id";

  -- A later head update in the same transaction supersedes this queued check.
  IF "active_version_id" IS DISTINCT FROM NEW."current_version_id" THEN
    RETURN NEW;
  END IF;

  SELECT "agent_id", "facts"
    INTO "version_agent_id", "version_facts"
    FROM "agent_profile_versions"
   WHERE "id" = NEW."current_version_id";

  IF NOT FOUND OR "version_agent_id" IS DISTINCT FROM NEW."agent_id" THEN
    RAISE EXCEPTION 'profile current version must belong to the same agent'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_profiles_current_version_provenance_check';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements("version_facts") AS "fact"
     WHERE NOT EXISTS (
       SELECT 1
         FROM "agent_profile_version_sources" AS "source"
        WHERE "source"."profile_version_id" = NEW."current_version_id"
          AND "source"."fact_key" = "fact"->>'factKey'
     )
  ) OR EXISTS (
    SELECT 1
      FROM "agent_profile_version_sources" AS "source"
     WHERE "source"."profile_version_id" = NEW."current_version_id"
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements("version_facts") AS "fact"
          WHERE "fact"->>'factKey' = "source"."fact_key"
       )
  ) THEN
    RAISE EXCEPTION 'profile current version facts and sources must match'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_profiles_current_version_provenance_check';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_profiles_current_version_provenance_check"
AFTER INSERT OR UPDATE OF "current_version_id" ON "agent_profiles"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "agent_profile_validate_current_version"();
