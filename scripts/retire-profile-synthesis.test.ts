import { describe, expect, it, vi } from "vitest";

import {
  type ProfileRetirementBoss,
  retireProfileSynthesis,
} from "@/scripts/retire-profile-synthesis";

function createBoss(options?: { unscheduleError?: Error; schedules?: unknown[] }) {
  const calls: string[] = [];
  const boss = {
    start: vi.fn(async () => void calls.push("start")),
    unschedule: vi.fn(async () => {
      calls.push("unschedule");
      if (options?.unscheduleError) throw options.unscheduleError;
    }),
    deleteQueue: vi.fn(async (name: string) => void calls.push(`delete:${name}`)),
    getSchedules: vi.fn(async () => {
      calls.push("verify");
      return options?.schedules ?? [];
    }),
    stop: vi.fn(async () => void calls.push("stop")),
  };
  return { boss: boss as unknown as ProfileRetirementBoss, calls, mocks: boss };
}

describe("retireProfileSynthesis", () => {
  it("unschedules before deleting both queues and verifies cleanup", async () => {
    const { boss, calls, mocks } = createBoss();
    await retireProfileSynthesis(boss);
    expect(calls).toEqual([
      "start",
      "unschedule",
      "delete:agent-profile-synthesis",
      "delete:agent-profile-synthesis-dlq",
      "verify",
      "stop",
    ]);
    expect(mocks.unschedule).toHaveBeenCalledWith(
      "agent-profile-synthesis",
      "agent-profile-synthesis-schedule",
    );
    expect(mocks.stop).toHaveBeenCalledWith({ graceful: true });
  });

  it("is idempotent when the old schedule is missing", async () => {
    const { boss, mocks } = createBoss({ unscheduleError: new Error("schedule missing") });
    await expect(retireProfileSynthesis(boss)).resolves.toBeUndefined();
    expect(mocks.deleteQueue).toHaveBeenCalledTimes(2);
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("fails verification and still stops its private boss instance", async () => {
    const { boss, mocks } = createBoss({ schedules: [{}] });
    await expect(retireProfileSynthesis(boss)).rejects.toThrow(
      "Profile synthesis schedule still exists after retirement.",
    );
    expect(mocks.stop).toHaveBeenCalledWith({ graceful: true });
  });
});
