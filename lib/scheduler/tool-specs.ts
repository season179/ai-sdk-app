import type { ToolSet } from "ai";

import {
  buildSpecToolSet,
  type RealisticToolInput,
  type RealisticToolSpec,
} from "@/lib/mock-tools";
import { ScheduledPayloadError } from "@/lib/scheduler/execute";
import {
  cancelScheduledTask,
  createScheduledTask,
  getScheduledTaskRuns,
  listScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  type ScheduledTask,
  SchedulerInputError,
} from "@/lib/scheduler/tasks";

export const schedulerToolSpecs: RealisticToolSpec[] = [
  {
    name: "scheduled_task_create",
    title: "Create scheduled task",
    service: "scheduler",
    action: "create",
    description:
      "Schedule a real task that runs later. Payload kind 'tool_call' (default) executes one catalog tool with fixed arguments; kind 'instruction' runs a free-form instruction through an agent loop each time it fires and judges whether to continue. One-off tasks require run_at; recurring tasks require a cron expression and run in the given IANA timezone (default UTC). One-off instruction tasks re-schedule themselves after each round until the agent stops or max_rounds is reached. Returns the created task with its id.",
    properties: {
      title: { type: "string", description: "Short human-readable task title." },
      kind: {
        type: "string",
        enum: ["tool_call", "instruction"],
        description:
          "Payload kind. 'tool_call' (default) executes one catalog tool; 'instruction' runs an agent loop over a free-form instruction at fire time.",
      },
      tool_name: {
        type: "string",
        description:
          "Exact name of the catalog tool to execute when the task runs. Required when kind is 'tool_call'. Scheduler and skill tools cannot be scheduled.",
      },
      tool_arguments: {
        type: "object",
        description: "Arguments passed to the tool when the task runs (kind 'tool_call').",
        additionalProperties: true,
      },
      instruction: {
        type: "string",
        description:
          "Free-form instruction executed each round, e.g. 'check in on the data export and report progress'. Required when kind is 'instruction'.",
      },
      max_rounds: {
        type: "number",
        description:
          "Hard cap on instruction rounds (default 10, max 100). The chain stops at this cap regardless of the agent's judgment.",
      },
      cadence_seconds: {
        type: "number",
        description:
          "Intended seconds between instruction rounds (min 30). One-off instruction tasks re-schedule themselves at this cadence unless the agent requests a different delay.",
      },
      schedule_type: {
        type: "string",
        enum: ["once", "cron"],
        description: "'once' for a single future run, 'cron' for a recurring schedule.",
      },
      run_at: {
        type: "string",
        description:
          "ISO 8601 timestamp with timezone offset for one-off tasks, e.g. 2026-06-08T09:30:00+08:00.",
      },
      cron: {
        type: "string",
        description: "5-field cron expression for recurring tasks, e.g. '*/5 * * * *'.",
      },
      timezone: {
        type: "string",
        description:
          "IANA timezone the cron expression is evaluated in, e.g. Asia/Kuala_Lumpur. Defaults to UTC.",
      },
    },
    required: ["title", "schedule_type"],
  },
  {
    name: "scheduled_task_list",
    title: "List scheduled tasks",
    service: "scheduler",
    action: "list",
    description:
      "List scheduled tasks with their type (one-off or recurring), schedule, timezone, status, and last run state.",
    properties: {},
  },
  {
    name: "scheduled_task_cancel",
    title: "Cancel scheduled task",
    service: "scheduler",
    action: "cancel",
    description:
      "Cancel a scheduled task by id. One-off tasks lose their pending run; recurring tasks stop producing new runs.",
    properties: {
      task_id: { type: "string", description: "Id of the scheduled task to cancel." },
    },
    required: ["task_id"],
  },
  {
    name: "scheduled_task_pause",
    title: "Pause scheduled task",
    service: "scheduler",
    action: "pause",
    description:
      "Pause an active scheduled task by id so it produces no runs until resumed. Works for one-off and recurring tasks.",
    properties: {
      task_id: { type: "string", description: "Id of the scheduled task to pause." },
    },
    required: ["task_id"],
  },
  {
    name: "scheduled_task_resume",
    title: "Resume scheduled task",
    service: "scheduler",
    action: "resume",
    description:
      "Resume a paused scheduled task by id. One-off tasks can only resume while their run time is still in the future.",
    properties: {
      task_id: { type: "string", description: "Id of the scheduled task to resume." },
    },
    required: ["task_id"],
  },
  {
    name: "scheduled_task_get_runs",
    title: "Get scheduled task runs",
    service: "scheduler",
    action: "get",
    description:
      "Get the execution history of a scheduled task by id, including run status, output, and errors.",
    properties: {
      task_id: { type: "string", description: "Id of the scheduled task to inspect." },
    },
    required: ["task_id"],
  },
];

const schedulerSpecByName = new Map(schedulerToolSpecs.map((spec) => [spec.name, spec]));

export function getSchedulerToolSpec(name: string) {
  return schedulerSpecByName.get(name);
}

export function isSchedulerToolName(name: string) {
  return schedulerSpecByName.has(name);
}

export async function executeSchedulerTool(name: string, input: RealisticToolInput) {
  try {
    switch (name) {
      case "scheduled_task_create": {
        const scheduleType = input.schedule_type === "cron" ? "cron" : "once";
        const payload =
          input.kind === "instruction"
            ? {
                kind: "instruction",
                instruction: input.instruction,
                maxRounds: input.max_rounds,
                cadenceSeconds: input.cadence_seconds,
              }
            : {
                kind: "tool_call",
                toolName: input.tool_name,
                arguments: input.tool_arguments ?? {},
              };
        const task = await createScheduledTask({
          title: String(input.title ?? ""),
          payload,
          scheduleType,
          runAt: asOptionalString(input.run_at),
          cron: asOptionalString(input.cron),
          timezone: asOptionalString(input.timezone),
        });

        return {
          success: true,
          task: formatTask(task),
          note: `${task.scheduleType === "once" ? "One-off" : "Recurring"} task created. ${describeSchedule(task)}`,
        };
      }
      case "scheduled_task_list": {
        const tasks = await listScheduledTasks();

        return {
          success: true,
          count: tasks.length,
          tasks: tasks.map(formatTask),
        };
      }
      case "scheduled_task_cancel": {
        const task = await cancelScheduledTask(requireTaskId(input));

        return {
          success: true,
          task: formatTask(task),
          note: "Task cancelled. No further runs will be created.",
        };
      }
      case "scheduled_task_pause": {
        const task = await pauseScheduledTask(requireTaskId(input));

        return {
          success: true,
          task: formatTask(task),
          note: "Task paused. Resume it to schedule runs again.",
        };
      }
      case "scheduled_task_resume": {
        const task = await resumeScheduledTask(requireTaskId(input));

        return {
          success: true,
          task: formatTask(task),
          note: `Task resumed. ${describeSchedule(task)}`,
        };
      }
      case "scheduled_task_get_runs": {
        const taskId = requireTaskId(input);
        const runs = await getScheduledTaskRuns(taskId);

        return {
          success: true,
          taskId,
          count: runs.length,
          runs,
        };
      }
      default:
        return {
          success: false,
          error: `'${name}' is not a scheduler tool.`,
        };
    }
  } catch (error) {
    if (error instanceof SchedulerInputError || error instanceof ScheduledPayloadError) {
      return { success: false, error: error.message };
    }

    console.error(`Scheduler tool ${name} failed`, error);
    return {
      success: false,
      error:
        "The scheduler is unavailable. Check that Postgres is running and DATABASE_URL is set.",
    };
  }
}

/** Real AI SDK tools, used when TOOL_EXPOSURE_MODE=all exposes every tool directly. */
export const schedulerTools: ToolSet = buildSpecToolSet(schedulerToolSpecs, executeSchedulerTool);

function formatTask(task: ScheduledTask) {
  return {
    id: task.id,
    title: task.title,
    type: task.scheduleType === "once" ? "one-off" : "recurring",
    runAt: task.runAt,
    cron: task.cron,
    timezone: task.timezone,
    status: task.status,
    executes:
      task.payload.kind === "tool_call"
        ? {
            kind: "tool_call",
            toolName: task.payload.toolName,
            arguments: task.payload.arguments,
          }
        : {
            kind: "instruction",
            instruction: task.payload.instruction,
            round: task.payload.round,
            maxRounds: task.payload.maxRounds,
            cadenceSeconds: task.payload.cadenceSeconds,
          },
    lastRun: task.lastRun,
    createdAt: task.createdAt,
  };
}

function describeSchedule(task: ScheduledTask) {
  if (task.scheduleType !== "once") {
    return `Cron '${task.cron}' is evaluated in ${task.timezone}.`;
  }

  if (task.payload.kind === "instruction") {
    return `It first runs at ${task.runAt} (UTC) and re-schedules itself for up to ${task.payload.maxRounds} rounds.`;
  }

  return `It will run once at ${task.runAt} (UTC).`;
}

function requireTaskId(input: RealisticToolInput) {
  const taskId = typeof input.task_id === "string" ? input.task_id.trim() : "";

  if (!taskId) {
    throw new SchedulerInputError("task_id is required.");
  }

  return taskId;
}

function asOptionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
