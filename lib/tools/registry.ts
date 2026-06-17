import {
  executeMockTool,
  mockToolSpecs,
  type RealisticToolInput,
  type RealisticToolSpec,
} from "@/lib/mock-tools";
import {
  executeSchedulerTool,
  type SchedulerToolContext,
  schedulerToolSpecs,
} from "@/lib/scheduler/tool-specs";
import { executeSkillTool, skillToolSpecs } from "@/lib/skills/tool-specs";

/**
 * Context threaded through tool execution. Only scheduler tools consume it
 * today (to append a created task's rounds back into the originating chat);
 * every other provider ignores the argument.
 */
export type ToolExecutionContext = SchedulerToolContext;

/**
 * A tool provider contributes its specs plus a single executor that dispatches
 * by tool name. Each provider keeps its own internal name dispatch and error
 * handling; the registry only needs the spec list and the entry point.
 */
export type ToolProvider = {
  specs: RealisticToolSpec[];
  execute: (
    name: string,
    input: RealisticToolInput,
    ctx: ToolExecutionContext,
  ) => unknown | Promise<unknown>;
};

export type ToolRegistry = {
  /** Every registered spec, preserving provider registration order. */
  specs: RealisticToolSpec[];
  getSpec: (name: string) => RealisticToolSpec | undefined;
  has: (name: string) => boolean;
  execute: (
    name: string,
    input: RealisticToolInput,
    ctx: ToolExecutionContext,
  ) => unknown | Promise<unknown>;
};

/**
 * Folds the providers into one lookup/execute surface so callers route by tool
 * name through a single registry instead of a per-provider fallback chain. Tool
 * names are unique across providers; a collision is a wiring bug and throws at
 * module load rather than silently shadowing one provider with another.
 */
export function createToolRegistry(providers: ToolProvider[]): ToolRegistry {
  const specs: RealisticToolSpec[] = [];
  const specByName = new Map<string, RealisticToolSpec>();
  const executeByName = new Map<string, ToolProvider["execute"]>();

  for (const provider of providers) {
    for (const spec of provider.specs) {
      if (specByName.has(spec.name)) {
        throw new Error(`Duplicate tool name '${spec.name}' registered in the tool registry.`);
      }

      specs.push(spec);
      specByName.set(spec.name, spec);
      executeByName.set(spec.name, provider.execute);
    }
  }

  return {
    specs,
    getSpec: (name) => specByName.get(name),
    has: (name) => specByName.has(name),
    execute: (name, input, ctx) => executeByName.get(name)?.(name, input, ctx),
  };
}

/**
 * Provider registration order matches the legacy catalog concatenation
 * (mock, scheduler, skill) so deferred-tool search keeps its existing tie-break
 * ordering.
 */
const toolProviders: ToolProvider[] = [
  { specs: mockToolSpecs, execute: (name, input) => executeMockTool(name, input) },
  {
    specs: schedulerToolSpecs,
    execute: (name, input, ctx) => executeSchedulerTool(name, input, ctx),
  },
  { specs: skillToolSpecs, execute: (name, input) => executeSkillTool(name, input) },
];

/** Single registry the deferred tool_call path dispatches through. */
export const toolRegistry = createToolRegistry(toolProviders);
