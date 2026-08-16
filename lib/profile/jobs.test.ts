import { describe, expect, it, vi } from "vitest";

import {
  parseProfileSynthesisJobData,
  registerProfileSynthesisWorker,
  storedTriggerForJob,
} from "@/lib/profile/jobs";
import { profileSynthesisSendOptions } from "@/lib/scheduler/boss";

const agentId = "00000000-0000-0000-0000-000000000030";

describe("profile synthesis jobs", () => {
  it("parses only the two closed payload shapes", () => {
    expect(parseProfileSynthesisJobData({ kind: "sweep", trigger: "scheduled" })).toEqual({
      kind: "sweep",
      trigger: "scheduled",
    });
    expect(parseProfileSynthesisJobData({ kind: "agent", agentId, trigger: "turn" })).toEqual({
      kind: "agent",
      agentId,
      trigger: "turn",
    });
    expect(
      parseProfileSynthesisJobData({ kind: "agent", agentId: "bad", trigger: "turn" }),
    ).toBeNull();
    expect(parseProfileSynthesisJobData({ kind: "agent", agentId, trigger: "unknown" })).toBeNull();
    expect(parseProfileSynthesisJobData(null)).toBeNull();
  });

  it("maps queue triggers to stored immutable-version triggers", () => {
    expect(storedTriggerForJob("turn")).toBe("scheduled");
    expect(storedTriggerForJob("scheduled")).toBe("scheduled");
    expect(storedTriggerForJob("manual_ui")).toBe("manual_ui");
    expect(storedTriggerForJob("explicit_fallback")).toBe("explicit");
  });

  it("uses a per-agent singleton key", () => {
    expect(profileSynthesisSendOptions(agentId)).toEqual({ singletonKey: agentId });
  });

  it("ignores invalid payloads and rethrows handler failures", async () => {
    let callback: ((jobs: Array<{ id: string; data: unknown }>) => Promise<void>) | undefined;
    const boss = {
      work: vi.fn(async (_queue: string, _options: unknown, worker: typeof callback) => {
        callback = worker;
      }),
    };
    const handler = vi.fn(async () => {
      throw new Error("transient");
    });
    await registerProfileSynthesisWorker(boss as never, handler);
    await callback?.([{ id: "invalid", data: { kind: "bad" } }]);
    expect(handler).not.toHaveBeenCalled();
    await expect(
      callback?.([{ id: "job-1", data: { kind: "agent", agentId, trigger: "turn" } }]),
    ).rejects.toThrow("transient");
  });
});
