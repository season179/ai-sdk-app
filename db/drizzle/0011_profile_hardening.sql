CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
ALTER TABLE "agent_grounded_observations" ADD COLUMN "profile_generation" integer;--> statement-breakpoint
ALTER TABLE "agent_memory_versions" ADD COLUMN "profile_generation" integer;--> statement-breakpoint
ALTER TABLE "agent_profile_fact_tombstones" ADD COLUMN "claim_hash" text;--> statement-breakpoint
UPDATE "agent_profile_fact_tombstones" AS t
SET "claim_hash" = encode(digest(
  lower(regexp_replace(regexp_replace(coalesce((
    SELECT fact->>'sentence'
    FROM "agent_profile_versions" AS v,
      LATERAL jsonb_array_elements(v."facts") AS fact
    WHERE v."agent_id" = t."agent_id" AND fact->>'factKey' = t."fact_key"
    ORDER BY v."version_no" DESC
    LIMIT 1
  ), t."fact_key"), '[.!?。！？]+$', ''), '\s+', ' ', 'g')),
  'sha256'
), 'hex');--> statement-breakpoint
ALTER TABLE "agent_profile_fact_tombstones" ALTER COLUMN "claim_hash" SET NOT NULL;--> statement-breakpoint
INSERT INTO "agent_profiles" ("agent_id")
SELECT agent_id FROM "agent_grounded_observations"
UNION
SELECT m.agent_id FROM "agent_memory_versions" v JOIN "agent_memories" m ON m.id = v.memory_id
ON CONFLICT ("agent_id") DO NOTHING;--> statement-breakpoint
WITH evidence AS (
  SELECT o.agent_id, 'observation'::text AS lane, o.id, o.created_at,
    row_number() OVER (PARTITION BY o.agent_id ORDER BY o.created_at, o.id, 'observation') AS offset
  FROM "agent_grounded_observations" o
  UNION ALL
  SELECT m.agent_id, 'memory'::text, v.id, v.created_at,
    0::bigint
  FROM "agent_memory_versions" v JOIN "agent_memories" m ON m.id = v.memory_id
), ordered AS (
  SELECT agent_id, lane, id,
    row_number() OVER (PARTITION BY agent_id ORDER BY created_at, id, lane) AS offset
  FROM evidence
), assigned AS (
  SELECT ordered.*, p.dirty_generation + ordered.offset AS generation
  FROM ordered JOIN "agent_profiles" p USING (agent_id)
), update_observations AS (
  UPDATE "agent_grounded_observations" o SET profile_generation = assigned.generation
  FROM assigned WHERE assigned.lane = 'observation' AND assigned.id = o.id
), update_memories AS (
  UPDATE "agent_memory_versions" v SET profile_generation = assigned.generation
  FROM assigned WHERE assigned.lane = 'memory' AND assigned.id = v.id
)
UPDATE "agent_profiles" p SET dirty_generation = p.dirty_generation + counts.total
FROM (SELECT agent_id, count(*)::integer AS total FROM ordered GROUP BY agent_id) counts
WHERE counts.agent_id = p.agent_id;--> statement-breakpoint
CREATE INDEX "agent_grounded_observations_profile_generation_idx" ON "agent_grounded_observations" USING btree ("agent_id","profile_generation") WHERE "agent_grounded_observations"."profile_generation" is not null and "agent_grounded_observations"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "agent_memory_versions_profile_generation_idx" ON "agent_memory_versions" USING btree ("profile_generation") WHERE "agent_memory_versions"."profile_generation" is not null;--> statement-breakpoint
CREATE INDEX "agent_profile_fact_tombstones_claim_active_idx" ON "agent_profile_fact_tombstones" USING btree ("agent_id","claim_hash") WHERE "agent_profile_fact_tombstones"."retired_at" is null;--> statement-breakpoint
ALTER TABLE "agent_grounded_observations" ADD CONSTRAINT "agent_grounded_observations_profile_generation_check" CHECK ("agent_grounded_observations"."profile_generation" is null or "agent_grounded_observations"."profile_generation" > 0);--> statement-breakpoint
ALTER TABLE "agent_memory_versions" ADD CONSTRAINT "agent_memory_versions_profile_generation_check" CHECK ("agent_memory_versions"."profile_generation" is null or "agent_memory_versions"."profile_generation" > 0);--> statement-breakpoint
ALTER TABLE "agent_profile_fact_tombstones" ADD CONSTRAINT "agent_profile_fact_tombstones_claim_hash_check" CHECK (char_length("agent_profile_fact_tombstones"."claim_hash") = 64);