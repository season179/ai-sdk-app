import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  agentProfileFactTombstones,
  agentProfiles,
  agentProfileVersions,
  agentTraceEvents,
} from "@/db/schema";
import { reconcileLegacyTombstoneClaimHashes } from "@/lib/profile/hash-reconciliation";
import { profileClaimHash } from "@/lib/profile/reconcile";
import { closePool } from "@/lib/scheduler/db";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("legacy profile tombstone hash reconciliation", () => {
  afterAll(async () => closePool());

  it("re-hashes compatibility Unicode with the exact runtime normalizer", async () => {
    const agentId = randomUUID();
    const versionId = randomUUID();
    const laterVersionId = randomUUID();
    const eventId = randomUUID();
    const factKey = "unicode-legacy-claim";
    const sentence = "  Ｉ like pizza。  ";
    const laterSentence = "The user later prefers pasta.";
    const db = getDb();
    try {
      await db.insert(agentTraceEvents).values({
        id: eventId,
        agentId,
        traceId: `hash-reconcile:${eventId}`,
        sequenceNo: 0,
        eventType: "explicit_memory_write",
        actor: "user",
        trustClass: "user_assertion",
        payload: {},
        contentHash: `hash-${eventId}`,
        idempotencyKey: `hash-reconcile-${eventId}`,
        retentionClass: "audit",
        policyVersion: "test",
        occurredAt: new Date(),
      });
      await db.insert(agentProfileVersions).values([
        {
          id: versionId,
          agentId,
          versionNo: 1,
          body: sentence,
          facts: [
            {
              factKey,
              sentence,
              category: "preferences_constraints",
              authority: "user",
              protected: false,
              order: 0,
            },
          ],
          trigger: "explicit",
          authority: "user",
          tokenCount: 5,
          recordedDuring: sql`tstzrange(now(), now(), '[)')`,
          promptHash: `hash-reconcile-${versionId}`,
          policyVersion: "profile-v1",
        },
        {
          id: laterVersionId,
          agentId,
          versionNo: 2,
          body: laterSentence,
          facts: [
            {
              factKey,
              sentence: laterSentence,
              category: "preferences_constraints",
              authority: "user",
              protected: false,
              order: 0,
            },
          ],
          trigger: "explicit",
          authority: "user",
          tokenCount: 5,
          recordedDuring: sql`tstzrange(now(), now(), '[)')`,
          promptHash: `hash-reconcile-${laterVersionId}`,
          policyVersion: "profile-v1",
        },
      ]);
      await db.execute(sql`
        insert into agent_profile_fact_tombstones
          (agent_id, fact_key, claim_hash, deleted_by, explicit_trace_event_id)
        values (
          ${agentId},
          ${factKey},
          encode(digest(lower(regexp_replace(regexp_replace(${sentence}, '[.!?。！？]+$', ''), '\\s+', ' ', 'g')), 'sha256'), 'hex'),
          'user',
          ${eventId}
        )
      `);

      const before = await db
        .select({ claimHash: agentProfileFactTombstones.claimHash })
        .from(agentProfileFactTombstones)
        .where(eq(agentProfileFactTombstones.agentId, agentId));
      expect(before[0].claimHash).not.toBe(profileClaimHash(sentence));

      await expect(reconcileLegacyTombstoneClaimHashes(agentId)).resolves.toEqual({
        scanned: 1,
        legacyMatched: 1,
        updated: 1,
      });
      const [after] = await db
        .select({ claimHash: agentProfileFactTombstones.claimHash })
        .from(agentProfileFactTombstones)
        .where(eq(agentProfileFactTombstones.agentId, agentId));
      expect(after.claimHash).toBe(profileClaimHash(sentence));
      await expect(reconcileLegacyTombstoneClaimHashes(agentId)).resolves.toEqual({
        scanned: 1,
        legacyMatched: 0,
        updated: 0,
      });
    } finally {
      await db
        .delete(agentProfileFactTombstones)
        .where(eq(agentProfileFactTombstones.agentId, agentId));
      await db.delete(agentProfiles).where(eq(agentProfiles.agentId, agentId));
      await db.delete(agentProfileVersions).where(eq(agentProfileVersions.agentId, agentId));
      await db.delete(agentTraceEvents).where(eq(agentTraceEvents.agentId, agentId));
    }
  });
});
