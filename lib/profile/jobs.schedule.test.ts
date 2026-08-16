import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  automatic: false,
  cron: "0 3 * * *",
  timezone: "UTC",
  schedule: vi.fn(),
  unschedule: vi.fn(),
}));

vi.mock("@/lib/profile/config", () => ({
  getProfileSynthesisCron: () => mocks.cron,
  getProfileSynthesisTimezone: () => mocks.timezone,
  isAutomaticProfileSynthesisEnabled: () => mocks.automatic,
  isProfileSynthesisEnabled: () => true,
}));
vi.mock("@/lib/scheduler/boss", () => ({
  PROFILE_SYNTHESIS_QUEUE_NAME: "agent-profile-synthesis",
  profileSynthesisSendOptions: (key: string) => ({ singletonKey: key }),
  getBoss: async () => ({ schedule: mocks.schedule, unschedule: mocks.unschedule }),
}));

import { syncProfileSynthesisSchedule } from "@/lib/profile/jobs";

describe("profile synthesis schedule", () => {
  beforeEach(() => {
    mocks.automatic = false;
    mocks.cron = "0 3 * * *";
    mocks.timezone = "UTC";
    mocks.schedule.mockReset();
    mocks.unschedule.mockReset();
  });

  it("unschedules when disabled or cron is empty", async () => {
    await syncProfileSynthesisSchedule();
    expect(mocks.unschedule).toHaveBeenCalledWith(
      "agent-profile-synthesis",
      "agent-profile-synthesis-schedule",
    );
    mocks.automatic = true;
    mocks.cron = "";
    await syncProfileSynthesisSchedule();
    expect(mocks.unschedule).toHaveBeenCalledTimes(2);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("schedules one timezone-aware singleton sweep", async () => {
    mocks.automatic = true;
    mocks.timezone = "Asia/Singapore";
    await syncProfileSynthesisSchedule();
    expect(mocks.schedule).toHaveBeenCalledWith(
      "agent-profile-synthesis",
      "0 3 * * *",
      { kind: "sweep", trigger: "scheduled" },
      {
        key: "agent-profile-synthesis-schedule",
        tz: "Asia/Singapore",
        singletonKey: "sweep",
      },
    );
  });
});
