import type { ToolSet } from "ai";
import type { MemoryKind } from "@/db/schema";
import {
  buildSpecToolSet,
  type RealisticToolInput,
  type RealisticToolSpec,
} from "@/lib/mock-tools";
import { SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE } from "@/lib/self-improvement/errors";
import { searchMemories } from "@/lib/self-improvement/memories";
import { MEMORY_KINDS, parseMemoryKind } from "@/lib/self-improvement/validation";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/**
 * The agent-facing memory_search tool (§10.2). Mirrors the skills tool pattern
 * (buildSpecToolSet). One tool is enough — memories are short (≤2000 chars), so
 * search returns content inline (no separate _get).
 *
 * Read-only (§10.4): writes nothing, fires no events, updates no checkpoints.
 * The assistant turn that quotes a retrieved memory is derivative content that
 * can never become a grounded observation (firewall), so retrieval cannot
 * reintroduce the amplification loop.
 *
 * Do NOT add this to the shared toolRegistry (§10.3) — that registry feeds the
 * deferred tool-search path and would expose the tool even when the flag is off.
 * Expose it only as a direct tool in the route's `tools` object, gated by
 * MEMORY_SEARCH_ENABLED.
 */

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 20;

export const memoryToolSpecs: RealisticToolSpec[] = [
  {
    name: "memory_search",
    title: "Search memories",
    service: "memory",
    action: "search",
    description:
      "Search this agent's approved durable memories. Returns matching memories inline (id, kind, content, confidence, source). Use this when the pushed <declarative_memory> block doesn't already show what you need.",
    properties: {
      query: {
        type: "string",
        description: "Text matched with full-text search and typo-tolerant fallback.",
      },
      kind: {
        type: "string",
        description: `Optional kind filter. One of: ${MEMORY_KINDS.join(", ")}.`,
        enum: [...MEMORY_KINDS],
      },
      limit: {
        type: "integer",
        description: `Maximum number of matches to return. Default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX}.`,
        minimum: 1,
        maximum: SEARCH_LIMIT_MAX,
      },
    },
    required: ["query"],
  },
];

type MemoryToolHandler = (input: RealisticToolInput) => Promise<unknown>;

const memoryToolBodies: Record<string, MemoryToolHandler> = {
  memory_search: async (input) => {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) {
      return { success: false, error: "query is required." };
    }

    const kind = parseKind(input.kind);
    const limit = clampLimit(input.limit);

    const memories = await searchMemories(DEFAULT_AGENT_ID, query, { kind, limit });

    return {
      success: true,
      query,
      count: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        kind: m.kind,
        content: m.content,
        confidence: m.confidence,
        source: m.source,
      })),
    };
  },
};

export const memoryToolHandlers: Record<string, MemoryToolHandler> = Object.fromEntries(
  Object.entries(memoryToolBodies).map(([name, body]) => [
    name,
    async (input: RealisticToolInput) => {
      try {
        return await body(input);
      } catch (error) {
        console.error(`Memory tool ${name} failed`, error);
        return { success: false, error: SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE };
      }
    },
  ]),
);

export async function executeMemoryTool(name: string, input: RealisticToolInput) {
  const handler = memoryToolHandlers[name];
  if (!handler) {
    return { success: false, error: `'${name}' is not a memory tool.` };
  }
  return handler(input);
}

/** Real AI SDK tools, exposed directly (NOT via the shared registry) when the flag is on. */
export const memoryTools: ToolSet = buildSpecToolSet(memoryToolSpecs, executeMemoryTool);

function parseKind(value: unknown): MemoryKind | undefined {
  // Optional filter: absent → no kind constraint. Otherwise reuse the canonical
  // validator (it throws SelfImprovementInputError, which the handler wrapper
  // maps to the unavailable message).
  if (value == null) return undefined;
  return parseMemoryKind(value);
}

function clampLimit(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return SEARCH_LIMIT_DEFAULT;
  }
  return Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.trunc(parsed)));
}
