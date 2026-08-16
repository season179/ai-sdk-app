import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import {
  agentProfileFactTombstones,
  agentProfiles,
  agentProfileVersionSources,
  agentProfileVersions,
  agentTraceEvents,
} from "@/db/schema";
import { getCurrentProfileVersionForRun, getProfileVersionForRun } from "@/lib/profile/read";
import { profileClaimHash } from "@/lib/profile/reconcile";
import { closePool, getPool } from "@/lib/scheduler/db";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("profile serving reads", () => {
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const versionId = randomUUID();

  beforeAll(async () => {
    getPool();
    await getDb()
      .insert(agentProfileVersions)
      .values({
        id: versionId,
        agentId,
        versionNo: 1,
        body: "The user prefers concise replies.",
        facts: [],
        trigger: "scheduled",
        authority: "synthesized",
        tokenCount: 7,
        recordedDuring: sql`tstzrange(now(), null, '[)')`,
        promptHash: `test-${versionId}`,
        policyVersion: "profile-v1",
      });
    await getDb().insert(agentProfiles).values({ agentId, currentVersionId: versionId });
  });

  afterAll(async () => {
    await getDb().delete(agentProfiles).where(eq(agentProfiles.agentId, agentId));
    await getDb()
      .delete(agentProfileFactTombstones)
      .where(eq(agentProfileFactTombstones.agentId, agentId));
    const versions = await getDb()
      .select({ id: agentProfileVersions.id })
      .from(agentProfileVersions)
      .where(eq(agentProfileVersions.agentId, agentId));
    for (const version of versions) {
      await getDb()
        .delete(agentProfileVersionSources)
        .where(eq(agentProfileVersionSources.profileVersionId, version.id));
    }
    await getDb().delete(agentProfileVersions).where(eq(agentProfileVersions.agentId, agentId));
    await getDb().delete(agentTraceEvents).where(eq(agentTraceEvents.agentId, agentId));
    await closePool();
  });

  it("resolves the current head and exact immutable version under agent scope", async () => {
    const current = await getCurrentProfileVersionForRun(agentId);
    const exact = await getProfileVersionForRun(versionId, agentId);

    expect(current).toMatchObject({ id: versionId, agentId, versionNo: 1, tokenCount: 7 });
    expect(exact).toEqual(current);
    await expect(getProfileVersionForRun(versionId, otherAgentId)).resolves.toBeNull();
  });

  it("filters active semantic tombstones from historical bound versions", async () => {
    const historicalId = randomUUID();
    const traceId = randomUUID();
    const eventId = randomUUID();
    const sentence = "The user keeps a sensitive historical preference.";
    const fact = {
      factKey: "legacy-lane-key",
      sentence,
      category: "preferences_constraints" as const,
      authority: "user" as const,
      protected: false,
      order: 0,
    };
    await getDb()
      .insert(agentTraceEvents)
      .values({
        id: eventId,
        agentId,
        traceId,
        sequenceNo: 0,
        eventType: "explicit_memory_write",
        actor: "user",
        trustClass: "user_assertion",
        payload: {},
        contentHash: `hash-${eventId}`,
        idempotencyKey: `read-tombstone-${eventId}`,
        retentionClass: "audit",
        policyVersion: "test",
        occurredAt: new Date(),
      });
    await getDb()
      .insert(agentProfileVersions)
      .values({
        id: historicalId,
        agentId,
        versionNo: 2,
        body: sentence,
        facts: [fact],
        trigger: "explicit",
        authority: "user",
        tokenCount: 8,
        recordedDuring: sql`tstzrange(now(), now(), '[)')`,
        promptHash: `historical-${historicalId}`,
        policyVersion: "profile-v1",
      });
    await getDb().insert(agentProfileVersionSources).values({
      profileVersionId: historicalId,
      factKey: fact.factKey,
      traceEventId: eventId,
      sourceRole: "primary",
    });
    await getDb()
      .insert(agentProfileFactTombstones)
      .values({
        agentId,
        factKey: "different-lane-key",
        claimHash: profileClaimHash(sentence),
        deletedBy: "user",
        explicitTraceEventId: eventId,
      });

    const served = await getProfileVersionForRun(historicalId, agentId);
    expect(served).toMatchObject({ facts: [], body: "", tokenCount: 0 });
  });

  it("fails open before SQL when the shared deadline has passed", async () => {
    const onFailure = vi.fn();
    await expect(
      getCurrentProfileVersionForRun(agentId, { deadlineAt: Date.now() - 1, onFailure }),
    ).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
