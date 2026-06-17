import {
  mockToolHandlers,
  mockToolSpecs,
  type RealisticToolInput,
  type RealisticToolSpec,
} from "@/lib/mock-tools";
import {
  type SchedulerToolContext,
  schedulerToolHandlers,
  schedulerToolSpecs,
} from "@/lib/scheduler/tool-specs";
import { skillToolHandlers, skillToolSpecs } from "@/lib/skills/tool-specs";

/**
 * Context threaded through tool execution. Only scheduler tools consume it
 * today (to append a created task's rounds back into the originating chat);
 * every other provider ignores the argument.
 */
export type ToolExecutionContext = SchedulerToolContext;

/**
 * A single tool's executor, dispatched by the registry once a tool name has
 * been resolved. Each provider supplies one handler per tool name; the handler
 * already owns the provider's per-tool error handling.
 */
export type ToolHandler = (
  input: RealisticToolInput,
  ctx: ToolExecutionContext,
) => unknown | Promise<unknown>;

/**
 * A tool provider contributes its specs plus a handler map keyed by tool name.
 * The registry folds the specs and handlers into one flat per-tool dispatch
 * surface — no per-provider re-dispatch.
 */
export type ToolProvider = {
  specs: RealisticToolSpec[];
  handlers: Record<string, ToolHandler>;
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
 * Folds the providers into one flat per-tool dispatch surface so callers route
 * by tool name through a single registry instead of a per-provider fallback
 * chain. Tool names are unique across providers; a collision — or a spec with
 * no registered handler — is a wiring bug and throws at module load rather than
 * silently shadowing or dropping a tool.
 */
export function createToolRegistry(providers: ToolProvider[]): ToolRegistry {
  const specs: RealisticToolSpec[] = [];
  const specByName = new Map<string, RealisticToolSpec>();
  const executeByName = new Map<string, ToolHandler>();

  for (const provider of providers) {
    for (const spec of provider.specs) {
      if (specByName.has(spec.name)) {
        throw new Error(`Duplicate tool name '${spec.name}' registered in the tool registry.`);
      }

      const handler = provider.handlers[spec.name];

      if (!handler) {
        throw new Error(`Tool '${spec.name}' has a spec but no registered handler.`);
      }

      specs.push(spec);
      specByName.set(spec.name, spec);
      executeByName.set(spec.name, handler);
    }
  }

  return {
    specs,
    getSpec: (name) => specByName.get(name),
    has: (name) => specByName.has(name),
    execute: (name, input, ctx) => executeByName.get(name)?.(input, ctx),
  };
}

/**
 * Provider registration order matches the legacy catalog concatenation
 * (mock, scheduler, skill) so deferred-tool search keeps its existing tie-break
 * ordering.
 */
const toolProviders: ToolProvider[] = [
  { specs: mockToolSpecs, handlers: mockToolHandlers },
  { specs: schedulerToolSpecs, handlers: schedulerToolHandlers },
  { specs: skillToolSpecs, handlers: skillToolHandlers },
];

/** Single registry the deferred tool_call path dispatches through. */
export const toolRegistry = createToolRegistry(toolProviders);
