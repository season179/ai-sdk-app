-- Catch up grounded observations written by the legacy live writer after 0005.
INSERT INTO "agent_trace_events" (
  "agent_id", "trace_id", "sequence_no", "source_message_id", "event_type",
  "actor", "trust_class", "sensitivity_class", "payload", "content_hash",
  "idempotency_key", "retention_class", "policy_version", "occurred_at"
)
SELECT
  o."agent_id",
  'legacy-observation:' || o."id"::text || ':cutover',
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
  'legacy-observation:' || o."id"::text || ':cutover',
  'audit',
  'legacy-cutover-v1',
  o."created_at"
FROM "agent_grounded_observations" o
WHERE o."trace_event_id" IS NULL
ON CONFLICT ("agent_id", "idempotency_key") DO NOTHING;
--> statement-breakpoint

UPDATE "agent_grounded_observations" o
SET "trace_event_id" = e."id"
FROM "agent_trace_events" e
WHERE o."trace_event_id" IS NULL
  AND e."agent_id" = o."agent_id"
  AND e."idempotency_key" = 'legacy-observation:' || o."id"::text || ':cutover';
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_grounded_observations" WHERE "trace_event_id" IS NULL) THEN
    RAISE EXCEPTION 'grounded-observation cutover left null trace provenance';
  END IF;
END $$;
--> statement-breakpoint

-- Snapshot only roots whose mutable legacy head is newer/different or whose
-- current pointer is absent. A temporary table keeps one deterministic set
-- through event, version, provenance, and pointer writes.
CREATE TEMP TABLE "_agent_memory_cutover" ON COMMIT DROP AS
SELECT
  m."id" AS "memory_id",
  m."current_version_id" AS "prior_version_id",
  coalesce((SELECT max(v2."version_no") FROM "agent_memory_versions" v2 WHERE v2."memory_id" = m."id"), 0) + 1 AS "next_version_no",
  NULL::uuid AS "event_id",
  NULL::uuid AS "version_id"
FROM "agent_memories" m
LEFT JOIN "agent_memory_versions" v ON v."id" = m."current_version_id"
WHERE m."current_version_id" IS NULL
   OR m."content" IS DISTINCT FROM v."content"
   OR m."source" IS DISTINCT FROM v."source"
   OR m."confidence" IS DISTINCT FROM v."confidence";
--> statement-breakpoint

INSERT INTO "agent_trace_events" (
  "agent_id", "trace_id", "sequence_no", "session_id", "event_type", "actor",
  "trust_class", "sensitivity_class", "payload", "content_hash",
  "idempotency_key", "retention_class", "policy_version", "occurred_at"
)
SELECT
  m."agent_id",
  'legacy-memory:' || m."id"::text || ':cutover',
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
    'content', m."content",
    'cutover', true
  ),
  coalesce(m."claim_hash", md5(m."content")),
  'legacy-memory:' || m."id"::text || ':cutover',
  'audit',
  'legacy-cutover-v1',
  now()
FROM "_agent_memory_cutover" c
JOIN "agent_memories" m ON m."id" = c."memory_id"
ON CONFLICT ("agent_id", "idempotency_key") DO NOTHING;
--> statement-breakpoint

UPDATE "_agent_memory_cutover" c
SET "event_id" = e."id"
FROM "agent_memories" m
JOIN "agent_trace_events" e
  ON e."agent_id" = m."agent_id"
 AND e."idempotency_key" = 'legacy-memory:' || m."id"::text || ':cutover'
WHERE m."id" = c."memory_id";
--> statement-breakpoint

UPDATE "agent_memory_versions" v
SET "recorded_during" = tstzrange(lower(v."recorded_during"), now(), '[)')
FROM "_agent_memory_cutover" c
WHERE v."id" = c."prior_version_id"
  AND upper(v."recorded_during") IS NULL;
--> statement-breakpoint

INSERT INTO "agent_memory_versions" (
  "memory_id", "version_no", "content", "structured", "source",
  "recorded_during", "confidence", "operation",
  "supersedes_memory_version_id", "extractor_id", "schema_version",
  "policy_version", "authority", "sensitivity_class", "created_at"
)
SELECT
  m."id",
  c."next_version_no",
  m."content",
  '{}'::jsonb,
  m."source",
  tstzrange(now(), NULL, '[)'),
  m."confidence",
  CASE WHEN c."prior_version_id" IS NULL THEN 'ADD' ELSE 'UPDATE' END,
  c."prior_version_id",
  'legacy-cutover-v1',
  1,
  'legacy-cutover-v1',
  'legacy_import',
  'normal',
  now()
FROM "_agent_memory_cutover" c
JOIN "agent_memories" m ON m."id" = c."memory_id";
--> statement-breakpoint

UPDATE "_agent_memory_cutover" c
SET "version_id" = v."id"
FROM "agent_memory_versions" v
WHERE v."memory_id" = c."memory_id"
  AND v."version_no" = c."next_version_no";
--> statement-breakpoint

INSERT INTO "agent_memory_version_trace_events" (
  "memory_version_id", "event_id", "source_role"
)
SELECT c."version_id", c."event_id", 'primary'
FROM "_agent_memory_cutover" c
WHERE c."version_id" IS NOT NULL AND c."event_id" IS NOT NULL
ON CONFLICT ("memory_version_id", "event_id") DO NOTHING;
--> statement-breakpoint

UPDATE "agent_memories" m
SET
  "current_version_id" = c."version_id",
  "memory_type" = CASE
    WHEN m."kind" = 'episode' THEN 'episodic'
    WHEN m."kind" = 'procedure' THEN 'procedural'
    ELSE 'semantic'
  END,
  "conflict_policy" = CASE
    WHEN m."kind" IN ('preference', 'persona', 'correction') THEN 'replace_current'
    WHEN m."kind" = 'episode' THEN 'add_only'
    WHEN m."kind" = 'procedure' THEN 'version_evaluate'
    ELSE 'append_temporal'
  END,
  "scope_type" = CASE WHEN m."session_id" IS NULL THEN 'agent' ELSE 'session' END,
  "scope_id" = coalesce(m."session_id"::text, m."agent_id"::text),
  "tombstoned" = m."deleted_at" IS NOT NULL,
  "tombstoned_at" = m."deleted_at"
FROM "_agent_memory_cutover" c
WHERE m."id" = c."memory_id";
--> statement-breakpoint

-- Also normalize root metadata for unchanged migration-1 roots.
UPDATE "agent_memories" m
SET
  "memory_type" = CASE
    WHEN m."kind" = 'episode' THEN 'episodic'
    WHEN m."kind" = 'procedure' THEN 'procedural'
    ELSE 'semantic'
  END,
  "conflict_policy" = CASE
    WHEN m."kind" IN ('preference', 'persona', 'correction') THEN 'replace_current'
    WHEN m."kind" = 'episode' THEN 'add_only'
    WHEN m."kind" = 'procedure' THEN 'version_evaluate'
    ELSE 'append_temporal'
  END,
  "scope_type" = CASE WHEN m."session_id" IS NULL THEN 'agent' ELSE 'session' END,
  "scope_id" = coalesce(m."session_id"::text, m."agent_id"::text),
  "tombstoned" = m."deleted_at" IS NOT NULL,
  "tombstoned_at" = m."deleted_at";
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_memories"
    WHERE "status" <> 'creating' AND "current_version_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'memory cutover left a non-creating root without a current version';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "agent_grounded_observations" ALTER COLUMN "trace_event_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_current_version_shape_check" CHECK (("agent_memories"."status" = 'creating' and "agent_memories"."current_version_id" is null) or ("agent_memories"."status" <> 'creating' and "agent_memories"."current_version_id" is not null));
--> statement-breakpoint
ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_source_check";
--> statement-breakpoint
ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_content_check";
--> statement-breakpoint
ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_confidence_check";
--> statement-breakpoint
DROP INDEX "agent_memories_prompt_idx";
--> statement-breakpoint
DROP INDEX "agent_memories_claim_hash_uniq";
--> statement-breakpoint
ALTER TABLE "agent_memories" DROP COLUMN "content";
--> statement-breakpoint
ALTER TABLE "agent_memories" DROP COLUMN "source";
--> statement-breakpoint
ALTER TABLE "agent_memories" DROP COLUMN "confidence";
--> statement-breakpoint
ALTER TABLE "agent_memories" DROP COLUMN "deleted_at";
--> statement-breakpoint
CREATE INDEX "agent_memories_prompt_idx" ON "agent_memories" USING btree ("agent_id","kind","created_at") WHERE "agent_memories"."status" = 'approved' and "agent_memories"."revoked_at" is null and "agent_memories"."tombstoned" = false and "agent_memories"."injection_blocked" = false;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memories_claim_hash_uniq" ON "agent_memories" USING btree ("agent_id","kind","claim_hash") WHERE "agent_memories"."claim_hash" is not null and "agent_memories"."status" <> 'creating' and "agent_memories"."revoked_at" is null and "agent_memories"."tombstoned" = false;
