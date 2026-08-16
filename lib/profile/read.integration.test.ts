import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { agentProfiles, agentProfileVersions } from "@/db/schema";
import { getCurrentProfileVersionForRun, getProfileVersionForRun } from "@/lib/profile/read";
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
    await getDb().delete(agentProfileVersions).where(eq(agentProfileVersions.agentId, agentId));
    await closePool();
  });

  it("resolves the current head and exact immutable version under agent scope", async () => {
    const current = await getCurrentProfileVersionForRun(agentId);
    const exact = await getProfileVersionForRun(versionId, agentId);

    expect(current).toMatchObject({ id: versionId, agentId, versionNo: 1, tokenCount: 7 });
    expect(exact).toEqual(current);
    await expect(getProfileVersionForRun(versionId, otherAgentId)).resolves.toBeNull();
  });

  it("fails open before SQL when the shared deadline has passed", async () => {
    const onFailure = vi.fn();
    await expect(
      getCurrentProfileVersionForRun(agentId, { deadlineAt: Date.now() - 1, onFailure }),
    ).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
