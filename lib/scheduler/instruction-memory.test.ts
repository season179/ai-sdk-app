import { describe, expect, it } from "vitest";
import type { InstructionTaskPayload } from "@/lib/scheduler/execute";
import {
  buildRoundMessages,
  classifyInstructionVerdictAction,
  type InstructionVerdict,
} from "@/lib/scheduler/instruction";
import type { ScheduledTask } from "@/lib/scheduler/tasks";

const verdict: InstructionVerdict = {
  statusUpdate: "The condition is not met yet.",
  declaredRationale: "The observed value remains below the requested threshold.",
  expectedOutcome: "Another check is scheduled.",
  successCriteria: ["A next round is queued"],
  continue: true,
  nextDelaySeconds: 60,
};
const payload: InstructionTaskPayload = {
  kind: "instruction",
  instruction: "Monitor the condition.",
  round: 1,
  maxRounds: 3,
  cadenceSeconds: 60,
};

describe("scheduled instruction memory contract", () => {
  it("maps verdicts to deterministic worker actions", () => {
    expect(classifyInstructionVerdictAction("once", payload, verdict)).toBe("next_round_scheduled");
    expect(classifyInstructionVerdictAction("once", { ...payload, round: 3 }, verdict)).toBe(
      "task_completed",
    );
    expect(classifyInstructionVerdictAction("cron", payload, { ...verdict, continue: false })).toBe(
      "task_cancelled",
    );
  });

  it("keeps declared rationale out of the user-facing transcript message", () => {
    const task = { id: "00000000-0000-4000-8000-000000000001" } as ScheduledTask;
    const messages = buildRoundMessages(task, payload, verdict);
    expect(JSON.stringify(messages)).toContain(verdict.statusUpdate);
    expect(JSON.stringify(messages)).not.toContain(verdict.declaredRationale);
  });
});
