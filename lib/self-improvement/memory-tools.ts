import type { ToolSet } from "ai";
import type { MemoryKind } from "@/db/schema";
import {
  type ConversationSearchInput,
  ConversationSearchInputError,
  searchConversationsByTime,
} from "@/lib/chat/conversation-search";
import { searchRankedRecall } from "@/lib/memory/recall";
import {
  buildSpecToolSet,
  type RealisticToolInput,
  type RealisticToolSpec,
} from "@/lib/mock-tools";
import { isConversationSearchEnabled } from "@/lib/profile/config";
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
  {
    name: "conversation_time_search",
    title: "Search conversations by time",
    service: "memory",
    action: "search",
    description:
      "Read messages from prior live chat conversations in an exact time interval. Resolve relative dates such as yesterday to ISO-8601 instants before calling. Results are deterministic, chronological, and read-only; this is not fuzzy or semantic search.",
    properties: {
      from: {
        type: "string",
        format: "date-time",
        description: "Inclusive ISO-8601 instant with an explicit UTC offset.",
      },
      to: {
        type: "string",
        format: "date-time",
        description:
          "Exclusive ISO-8601 instant with an explicit UTC offset, at most 90 days later.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Tuple sort direction. Defaults to desc.",
      },
      role: {
        type: "string",
        enum: ["user", "assistant", "system"],
        description: "Optional message-role filter.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of messages. Defaults to 5; maximum 20.",
      },
      cursor: {
        type: "string",
        description: "Opaque keyset cursor returned by the previous call.",
      },
    },
    required: ["from", "to"],
  },
];

type MemoryToolHandler = (input: RealisticToolInput) => Promise<unknown>;
type RankedSearch = typeof searchRankedRecall;
type ConversationTimeSearch = typeof searchConversationsByTime;

type MemoryToolContext = { agentId?: string; sessionId?: string | null };

async function executeMemorySearch(
  input: RealisticToolInput,
  search: RankedSearch,
  context: MemoryToolContext,
) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { success: false, error: "query is required." };
  const kind = parseKind(input.kind);
  const limit = clampLimit(input.limit);
  const memories = await search({
    agentId: context.agentId ?? DEFAULT_AGENT_ID,
    sessionId: context.sessionId ?? undefined,
    query,
    kind,
    limit,
  });

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

async function executeConversationTimeSearch(
  input: RealisticToolInput,
  search: ConversationTimeSearch,
  context: MemoryToolContext,
) {
  const searchInput: ConversationSearchInput = {
    from: input.from as string,
    to: input.to as string,
    order: input.order as ConversationSearchInput["order"],
    role: input.role as ConversationSearchInput["role"],
    limit: input.limit as number | undefined,
    cursor: input.cursor as string | undefined,
  };
  return search(searchInput, { agentId: context.agentId ?? DEFAULT_AGENT_ID });
}

export async function executeMemoryTool(
  name: string,
  input: RealisticToolInput,
  dependencies: {
    search?: RankedSearch;
    conversationSearch?: ConversationTimeSearch;
    logger?: typeof console.error;
  } = {},
  context: MemoryToolContext = {},
) {
  try {
    if (name === "memory_search") {
      return await executeMemorySearch(input, dependencies.search ?? searchRankedRecall, context);
    }
    if (name === "conversation_time_search") {
      return await executeConversationTimeSearch(
        input,
        dependencies.conversationSearch ?? searchConversationsByTime,
        context,
      );
    }
    return { success: false, error: `'${name}' is not a memory tool.` };
  } catch (error) {
    if (error instanceof ConversationSearchInputError) {
      return { success: false, error: error.message };
    }
    (dependencies.logger ?? console.error)(`Memory tool ${name} failed`, error);
    return { success: false, error: SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE };
  }
}

export const memoryToolHandlers: Record<string, MemoryToolHandler> = {
  memory_search: (input) => executeMemoryTool("memory_search", input),
  conversation_time_search: (input) => executeMemoryTool("conversation_time_search", input),
};

/** Per-request tools close over server-side scope without exposing it in the schema. */
export function createMemoryTools(context: MemoryToolContext): ToolSet {
  const enabledSpecs = memoryToolSpecs.filter(
    (spec) => spec.name !== "conversation_time_search" || isConversationSearchEnabled(),
  );
  return buildSpecToolSet(enabledSpecs, (name, input) =>
    executeMemoryTool(name, input, {}, context),
  );
}

/** Independently gated entry point used when MEMORY_SEARCH_ENABLED is off. */
export function createConversationSearchTools(context: MemoryToolContext): ToolSet {
  if (!isConversationSearchEnabled()) return {};
  const spec = memoryToolSpecs.find((candidate) => candidate.name === "conversation_time_search");
  return spec
    ? buildSpecToolSet([spec], (name, input) => executeMemoryTool(name, input, {}, context))
    : {};
}

/** Default-scope export retained for non-chat callers and tests. */
export const memoryTools: ToolSet = createMemoryTools({ agentId: DEFAULT_AGENT_ID });

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
