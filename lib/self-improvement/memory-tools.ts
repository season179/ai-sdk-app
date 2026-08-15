import type { ToolSet } from "ai";
import type { MemoryKind } from "@/db/schema";
import { searchRankedRecall } from "@/lib/memory/recall";
import {
  buildSpecToolSet,
  type RealisticToolInput,
  type RealisticToolSpec,
} from "@/lib/mock-tools";
import { SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE } from "@/lib/self-improvement/errors";
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
      "Search ranked current memory with full-text and typo-aware lexical matching. Returns compact current decisions when relevant plus approved memories (id, type/kind, summary, date, provenance, confidence, score). Use this when <memory_context> is incomplete or absent.",
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
type RankedSearch = typeof searchRankedRecall;

async function executeMemorySearch(input: RealisticToolInput, search: RankedSearch) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { success: false, error: "query is required." };
  const kind = parseKind(input.kind);
  const limit = clampLimit(input.limit);
  const memories = await search({ agentId: DEFAULT_AGENT_ID, query, kind, limit });

  return {
    success: true,
    query,
    count: memories.length,
    memories: memories.map((item) =>
      item.category === "decision"
        ? {
            id: item.id,
            type: "decision",
            kind: "decision",
            summary: item.summary,
            content: item.summary,
            status: item.status,
            date: item.eventDate,
            provenance: item.provenanceTraceIds,
            confidence: item.confidence,
            score: roundedScore(item.score.composite),
            outcome: item.outcome,
          }
        : {
            id: item.id,
            versionId: item.versionId,
            type: item.memoryType,
            kind: item.type,
            summary: item.summary,
            content: item.summary,
            date: item.eventDate,
            provenance: item.provenanceTraceIds,
            confidence: item.confidence,
            source: item.sourceKind,
            score: roundedScore(item.score.composite),
          },
    ),
  };
}

export async function executeMemoryTool(
  name: string,
  input: RealisticToolInput,
  dependencies: { search?: RankedSearch; logger?: typeof console.error } = {},
) {
  if (name !== "memory_search") {
    return { success: false, error: `'${name}' is not a memory tool.` };
  }
  try {
    return await executeMemorySearch(input, dependencies.search ?? searchRankedRecall);
  } catch (error) {
    (dependencies.logger ?? console.error)(`Memory tool ${name} failed`, error);
    return { success: false, error: SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE };
  }
}

export const memoryToolHandlers: Record<string, MemoryToolHandler> = {
  memory_search: (input) => executeMemoryTool("memory_search", input),
};

/** Real AI SDK tools, exposed directly (NOT via the shared registry) when the flag is on. */
export const memoryTools: ToolSet = buildSpecToolSet(memoryToolSpecs, executeMemoryTool);

function parseKind(value: unknown): MemoryKind | undefined {
  // Optional filter: absent → no kind constraint. Otherwise reuse the canonical
  // validator (it throws SelfImprovementInputError, which the handler wrapper
  // maps to the unavailable message).
  if (value == null) return undefined;
  return parseMemoryKind(value);
}

function roundedScore(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
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
