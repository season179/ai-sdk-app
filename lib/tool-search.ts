import { jsonSchema, type ToolSet, tool } from "ai";

import {
  getMockToolFunctionSchema,
  getMockToolParameterSchema,
  type RealisticToolInput,
  type RealisticToolSpec,
} from "@/lib/mock-tools";
import type { SchedulerToolContext } from "@/lib/scheduler/tool-specs";
import {
  estimateTokensFromChars,
  type RequestTokenEstimate,
  type ToolSearchMetadata,
  type ToolSearchMode,
  type ToolSearchTraceEvent,
} from "@/lib/token-usage";
import { toolRegistry } from "@/lib/tools/registry";

type SearchInput = {
  query: string;
  limit?: number;
};

type DescribeInput = {
  name: string;
};

type DeferredCallInput = {
  name: string;
  arguments: RealisticToolInput;
};

type CatalogEntry = {
  spec: RealisticToolSpec;
  searchText: string;
  tokens: string[];
};

type SearchHit = {
  spec: RealisticToolSpec;
  score: number;
};

export const TOOL_SEARCH_NAME = "tool_search";
export const TOOL_DESCRIBE_NAME = "tool_describe";
export const TOOL_CALL_NAME = "tool_call";

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const TOKEN_RE = /[A-Za-z0-9]+/g;

const NO_SCHEDULER_CONTEXT: SchedulerToolContext = { originSessionId: null };

const catalogToolSpecs = toolRegistry.specs;
const catalog = catalogToolSpecs.map(buildCatalogEntry);
const catalogStats = buildCatalogStats(catalog);
const catalogSchemaChars = JSON.stringify(catalogToolSpecs.map(getMockToolFunctionSchema)).length;

export const catalogToolCount = catalogToolSpecs.length;

function getCatalogToolSpec(name: string) {
  return toolRegistry.getSpec(name);
}

export function resolveToolExposureMode(value: string | undefined): ToolSearchMode {
  return value?.trim().toLowerCase() === "all" ? "all" : "search";
}

export function createToolSearchTools(
  trace: ToolSearchTraceEvent[],
  schedulerContext: SchedulerToolContext = NO_SCHEDULER_CONTEXT,
): ToolSet {
  return {
    [TOOL_SEARCH_NAME]: tool<SearchInput, ReturnType<typeof runToolSearch>>({
      title: "Search deferred tools",
      description:
        "Search the hidden tool catalog when you need a capability that is not directly listed. Follow with tool_describe for the selected tool schema, then tool_call to invoke it.",
      inputSchema: jsonSchema<SearchInput>({
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keywords describing the capability you need, such as 'create github issue'.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of matching tools to return. Default 5.",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      execute(input) {
        const result = runToolSearch(input);
        trace.push({
          kind: "search",
          limit: result.limit,
          matches: result.matches.map((match) => ({
            name: match.name,
            score: match.score,
            service: match.service,
            title: match.title,
          })),
          query: result.query,
          totalAvailable: result.totalAvailable,
        });

        return result;
      },
    }),
    [TOOL_DESCRIBE_NAME]: tool<DescribeInput, ReturnType<typeof describeTool>>({
      title: "Describe deferred tool",
      description:
        "Load the full parameter schema for one tool returned by tool_search before invoking it with tool_call.",
      inputSchema: jsonSchema<DescribeInput>({
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Exact tool name returned by tool_search.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      }),
      execute(input) {
        const result = describeTool(input);
        trace.push({
          found: result.found,
          kind: "describe",
          name: result.name,
          service: result.service,
          title: result.title,
        });

        return result;
      },
    }),
    [TOOL_CALL_NAME]: tool<DeferredCallInput, Awaited<ReturnType<typeof callDeferredTool>>>({
      title: "Call deferred tool",
      description:
        "Invoke a hidden tool by exact name with arguments that match the schema returned by tool_describe.",
      inputSchema: jsonSchema<DeferredCallInput>({
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Exact tool name to invoke.",
          },
          arguments: {
            type: "object",
            description: "Tool arguments matching the schema returned by tool_describe.",
            additionalProperties: true,
          },
        },
        required: ["name", "arguments"],
        additionalProperties: false,
      }),
      async execute(input) {
        const result = await callDeferredTool(input, schedulerContext);
        const spec = getCatalogToolSpec(result.name);

        trace.push({
          action: spec?.action,
          found: result.found,
          kind: "call",
          name: result.name,
          service: spec?.service,
          title: spec?.title,
        });

        return result;
      },
    }),
  };
}

export function searchToolCatalog(query: string, limit = DEFAULT_SEARCH_LIMIT) {
  return searchCatalog(query, clampLimit(limit)).map((hit) => ({
    action: hit.spec.action,
    description: hit.spec.description,
    name: hit.spec.name,
    score: roundScore(hit.score),
    service: hit.spec.service,
    title: hit.spec.title,
  }));
}

export function buildToolSearchMetadata({
  mode,
  requestEstimates,
  sentToolCount,
  trace,
}: {
  mode: ToolSearchMode;
  requestEstimates: RequestTokenEstimate[];
  /** Actual number of tools handed to the agent for this request. */
  sentToolCount: number;
  trace: ToolSearchTraceEvent[];
}): ToolSearchMetadata {
  const requestCount = Math.max(1, requestEstimates.length);
  const sentSchemaChars = requestEstimates.reduce((sum, estimate) => sum + estimate.toolChars, 0);
  const baselineSchemaChars = catalogSchemaChars * requestCount;
  const savedSchemaChars = Math.max(0, baselineSchemaChars - sentSchemaChars);

  return {
    availableToolCount: catalogToolCount,
    baselineSchemaTokens: estimateTokensFromChars(baselineSchemaChars),
    callCount: trace.filter((event) => event.kind === "call").length,
    catalogSchemaTokens: estimateTokensFromChars(catalogSchemaChars),
    deferredToolCount: mode === "search" ? catalogToolCount : 0,
    describeCount: trace.filter((event) => event.kind === "describe").length,
    mode,
    requestCount,
    savedSchemaTokens: estimateTokensFromChars(savedSchemaChars),
    searchCount: trace.filter((event) => event.kind === "search").length,
    sentSchemaTokens: sentSchemaChars > 0 ? estimateTokensFromChars(sentSchemaChars) : 0,
    sentToolCount,
    trace,
  };
}

function runToolSearch(input: SearchInput) {
  const query = String(input.query ?? "").trim();
  const limit = clampLimit(input.limit);
  const matches = query ? searchToolCatalog(query, limit) : [];

  return {
    query,
    limit,
    totalAvailable: catalog.length,
    matches,
  };
}

function describeTool(input: DescribeInput) {
  const name = String(input.name ?? "").trim();
  const spec = getCatalogToolSpec(name);

  if (!spec) {
    return {
      found: false,
      name,
      error: `No deferred tool named '${name}' was found. Run tool_search again with a broader query.`,
    };
  }

  return {
    action: spec.action,
    description: spec.description,
    found: true,
    name: spec.name,
    parameters: getMockToolParameterSchema(spec),
    service: spec.service,
    title: spec.title,
  };
}

async function callDeferredTool(
  input: DeferredCallInput,
  schedulerContext: SchedulerToolContext = NO_SCHEDULER_CONTEXT,
) {
  const name = String(input.name ?? "").trim();
  const spec = getCatalogToolSpec(name);

  if (!spec) {
    return deferredToolNotFound(name);
  }

  const output = await toolRegistry.execute(name, toRecord(input.arguments), schedulerContext);

  if (!output) {
    return deferredToolNotFound(name);
  }

  return {
    ...output,
    found: true,
    name: spec.name,
    service: spec.service,
    action: spec.action,
    title: spec.title,
  };
}

function deferredToolNotFound(name: string) {
  return {
    found: false,
    name,
    error: `No deferred tool named '${name}' was found. Run tool_search before tool_call.`,
  };
}

function searchCatalog(query: string, limit: number): SearchHit[] {
  const queryTokens = Array.from(new Set(tokenize(query)));

  if (queryTokens.length === 0) {
    return [];
  }

  const scored = catalog
    .map((entry) => ({
      score: bm25Score(queryTokens, entry.tokens),
      spec: entry.spec,
    }))
    .filter((hit) => hit.score > 0);

  const hits = scored.length > 0 ? scored : substringFallback(queryTokens);

  return hits
    .sort(
      (first, second) =>
        second.score - first.score || first.spec.name.localeCompare(second.spec.name),
    )
    .slice(0, limit);
}

function bm25Score(queryTokens: string[], documentTokens: string[]) {
  if (documentTokens.length === 0) {
    return 0;
  }

  const termFrequency = new Map<string, number>();

  for (const token of documentTokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }

  const k1 = 1.5;
  const b = 0.75;
  let score = 0;

  for (const queryToken of queryTokens) {
    const documentFrequency = catalogStats.documentFrequency.get(queryToken) ?? 0;

    if (documentFrequency === 0) {
      continue;
    }

    const idf = Math.log(
      1 + (catalogStats.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    const frequency = termFrequency.get(queryToken) ?? 0;

    if (frequency === 0) {
      continue;
    }

    const lengthNorm =
      (frequency * (k1 + 1)) /
      (frequency +
        k1 *
          (1 - b + b * (documentTokens.length / Math.max(catalogStats.averageDocumentLength, 1))));
    score += idf * lengthNorm;
  }

  return score;
}

function substringFallback(queryTokens: string[]): SearchHit[] {
  return catalog
    .map((entry) => {
      const score = queryTokens.reduce(
        (sum, token) => sum + (entry.searchText.toLowerCase().includes(token) ? 0.1 : 0),
        0,
      );

      return {
        score,
        spec: entry.spec,
      };
    })
    .filter((hit) => hit.score > 0);
}

function buildCatalogEntry(spec: RealisticToolSpec): CatalogEntry {
  const parameterNames = Object.keys(spec.properties).join(" ");
  const searchText = [
    splitIdentifier(spec.name),
    splitIdentifier(spec.service),
    spec.action,
    spec.title,
    spec.description,
    parameterNames,
  ].join(" ");

  return {
    searchText,
    spec,
    tokens: tokenize(searchText),
  };
}

function buildCatalogStats(entries: CatalogEntry[]) {
  const documentFrequency = new Map<string, number>();
  const documentLengths = entries.map((entry) => entry.tokens.length);

  for (const entry of entries) {
    for (const token of new Set(entry.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  return {
    averageDocumentLength:
      documentLengths.reduce((sum, length) => sum + length, 0) /
      Math.max(documentLengths.length, 1),
    documentCount: entries.length,
    documentFrequency,
  };
}

function tokenize(text: string) {
  return (text.match(TOKEN_RE) ?? []).map((token) => token.toLowerCase());
}

function splitIdentifier(value: string) {
  return value.replace(/[_:.-]+/g, " ");
}

function clampLimit(value: unknown) {
  return Math.max(
    1,
    Math.min(MAX_SEARCH_LIMIT, Number.isInteger(value) ? Number(value) : DEFAULT_SEARCH_LIMIT),
  );
}

function roundScore(score: number) {
  return Math.round(score * 1000) / 1000;
}

function toRecord(value: unknown): RealisticToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RealisticToolInput)
    : {};
}
