import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sent: vi.fn(),
  profiles: [
    { agentId: "00000000-0000-0000-0000-000000000041" },
    { agentId: "00000000-0000-0000-0000-000000000042" },
  ],
  sessions: [
    { agentId: "00000000-0000-0000-0000-000000000042" },
    { agentId: "00000000-0000-0000-0000-000000000043" },
  ],
  memories: [{ agentId: "00000000-0000-0000-0000-000000000044" }],
  reconcileHashes: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({ isNull: () => ({}) }));
vi.mock("@/db/schema", () => ({
  agentProfiles: { agentId: "profile-agent", table: "profiles" },
  agentChatSessions: {
    agentId: "session-agent",
    deletedAt: "session-deleted",
    table: "sessions",
  },
  agentMemories: { agentId: "memory-agent", table: "memories" },
}));
vi.mock("@/db", () => ({
  getDb: () => ({
    selectDistinct: ({ agentId }: { agentId: string }) => ({
      from: () => {
        if (agentId === "session-agent") {
          return { where: async () => mocks.sessions };
        }
        return Promise.resolve(agentId === "profile-agent" ? mocks.profiles : mocks.memories);
      },
    }),
  }),
}));
vi.mock("@/lib/profile/config", () => ({
  getProfileSynthesisCron: () => "0 3 * * *",
  getProfileSynthesisTimezone: () => "UTC",
  isAutomaticProfileSynthesisEnabled: () => true,
  isProfileSynthesisEnabled: () => true,
}));
vi.mock("@/lib/profile/hash-reconciliation", () => ({
  reconcileLegacyTombstoneClaimHashes: mocks.reconcileHashes,
}));
vi.mock("@/lib/scheduler/boss", () => ({
  PROFILE_SYNTHESIS_QUEUE_NAME: "agent-profile-synthesis",
  profileSynthesisSendOptions: (key: string) => ({ singletonKey: key }),
  getBoss: async () => ({ send: mocks.sent }),
}));
vi.mock("@/lib/utils", () => ({
  isUuid: (value: string) => /^00000000-0000-0000-0000-0000000000\d\d$/.test(value),
}));

import { enqueueProfileSweepAgents } from "@/lib/profile/jobs";

describe("profile synthesis daily sweep", () => {
  beforeEach(() => {
    mocks.sent.mockReset();
    mocks.reconcileHashes
      .mockReset()
      .mockResolvedValue({ scanned: 0, legacyMatched: 0, updated: 0 });
    mocks.sent.mockImplementation(async (_queue, data) => `job:${data.agentId}`);
  });

  it("enqueues every distinct agent from profiles, live sessions, and memories", async () => {
    await expect(enqueueProfileSweepAgents()).resolves.toBe(4);
    expect(mocks.reconcileHashes).toHaveBeenCalledTimes(1);
    expect(mocks.sent.mock.calls.map((call) => call[1].agentId).sort()).toEqual([
      "00000000-0000-0000-0000-000000000041",
      "00000000-0000-0000-0000-000000000042",
      "00000000-0000-0000-0000-000000000043",
      "00000000-0000-0000-0000-000000000044",
    ]);
    expect(mocks.sent.mock.calls.every((call) => call[2].singletonKey === call[1].agentId)).toBe(
      true,
    );
  });
});
