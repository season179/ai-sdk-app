import type { LanguageModelUsage } from "ai";

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
};

export type RequestToolEstimate = {
  name: string;
  chars: number;
};

export type RequestTokenEstimate = {
  systemPromptChars: number;
  messageChars: number;
  toolChars: number;
  requestOptionChars: number;
  messageCount: number;
  toolCount: number;
  tools: RequestToolEstimate[];
};

export type TokenUsageBreakdownCategoryId = "systemPrompt" | "messages" | "tools";

export type TokenUsageBreakdownCategory = {
  id: TokenUsageBreakdownCategoryId;
  label: string;
  tokens: number;
  percentage: number;
  chars: number;
};

export type TokenUsageToolBreakdown = {
  name: string;
  tokens: number;
  percentage: number;
  chars: number;
};

export type TokenUsageBreakdown = {
  inputTokens?: number;
  estimated: true;
  requestCount: number;
  messageCount: number;
  toolCount: number;
  excludedRequestOptionChars: number;
  excludedRequestOptionTokens: number;
  categories: TokenUsageBreakdownCategory[];
  tools: TokenUsageToolBreakdown[];
};

export type ToolSearchMode = "all" | "search";

export type ToolSearchMatch = {
  name: string;
  title: string;
  service: string;
  score: number;
};

export type ToolSearchTraceEvent =
  | {
      kind: "search";
      query: string;
      limit: number;
      totalAvailable: number;
      matches: ToolSearchMatch[];
    }
  | {
      kind: "describe";
      name: string;
      found: boolean;
      title?: string;
      service?: string;
    }
  | {
      kind: "call";
      name: string;
      found: boolean;
      title?: string;
      service?: string;
      action?: string;
    };

export type ToolSearchMetadata = {
  mode: ToolSearchMode;
  availableToolCount: number;
  sentToolCount: number;
  deferredToolCount: number;
  requestCount: number;
  catalogSchemaTokens: number;
  sentSchemaTokens: number;
  baselineSchemaTokens: number;
  savedSchemaTokens: number;
  searchCount: number;
  describeCount: number;
  callCount: number;
  trace: ToolSearchTraceEvent[];
};

export type ChatMessageMetadata = {
  /** Set by the composer on user messages that start with a /skill-name command. */
  activatedSkill?: string;
  /** OpenRouter model id that produced this assistant turn. */
  modelId?: string;
  tokenUsage?: TokenUsage;
  tokenUsageBreakdown?: TokenUsageBreakdown;
  toolSearch?: ToolSearchMetadata;
  /**
   * Marks a turn appended by the scheduled-task worker (vs. a normal chat turn).
   * The UI renders these distinctly and edit-truncation can preserve them (K3).
   */
  origin?: "scheduled";
  /** 1-based round number that produced this scheduled turn. */
  scheduledRound?: number;
  /** The scheduled task that produced this turn. */
  taskId?: string;
};

export function toTokenUsage(usage: LanguageModelUsage): TokenUsage {
  return compactTokenUsage({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? usage.reasoningTokens,
    cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? usage.cachedInputTokens,
    totalTokens: usage.totalTokens,
  });
}

export function getTokenUsage(metadata: unknown): TokenUsage | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.tokenUsage)) {
    return undefined;
  }

  return compactTokenUsage({
    inputTokens: readTokenCount(metadata.tokenUsage.inputTokens),
    outputTokens: readTokenCount(metadata.tokenUsage.outputTokens),
    reasoningTokens: readTokenCount(metadata.tokenUsage.reasoningTokens),
    cachedInputTokens: readTokenCount(metadata.tokenUsage.cachedInputTokens),
    totalTokens: readTokenCount(metadata.tokenUsage.totalTokens),
  });
}

export function getTokenUsageBreakdown(metadata: unknown): TokenUsageBreakdown | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.tokenUsageBreakdown)) {
    return undefined;
  }

  const breakdown = metadata.tokenUsageBreakdown;
  const categories = Array.isArray(breakdown.categories)
    ? breakdown.categories.map(readBreakdownCategory).filter(isDefined)
    : [];

  if (categories.length === 0) {
    return undefined;
  }

  return {
    inputTokens: readTokenCount(breakdown.inputTokens),
    estimated: true,
    requestCount: readPositiveInteger(breakdown.requestCount) ?? 1,
    messageCount: readPositiveInteger(breakdown.messageCount) ?? 0,
    toolCount: readPositiveInteger(breakdown.toolCount) ?? 0,
    excludedRequestOptionChars: readPositiveInteger(breakdown.excludedRequestOptionChars) ?? 0,
    excludedRequestOptionTokens: readPositiveInteger(breakdown.excludedRequestOptionTokens) ?? 0,
    categories,
    tools: Array.isArray(breakdown.tools)
      ? breakdown.tools.map(readToolBreakdown).filter(isDefined)
      : [],
  };
}

export function getToolSearchMetadata(metadata: unknown): ToolSearchMetadata | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.toolSearch)) {
    return undefined;
  }

  const toolSearch = metadata.toolSearch;
  const mode = toolSearch.mode === "all" || toolSearch.mode === "search" ? toolSearch.mode : null;

  if (!mode) {
    return undefined;
  }

  const availableToolCount = readPositiveInteger(toolSearch.availableToolCount);
  const sentToolCount = readPositiveInteger(toolSearch.sentToolCount);
  const deferredToolCount = readPositiveInteger(toolSearch.deferredToolCount);
  const requestCount = readPositiveInteger(toolSearch.requestCount);
  const catalogSchemaTokens = readPositiveInteger(toolSearch.catalogSchemaTokens);
  const sentSchemaTokens = readPositiveInteger(toolSearch.sentSchemaTokens);
  const baselineSchemaTokens = readPositiveInteger(toolSearch.baselineSchemaTokens);
  const savedSchemaTokens = readPositiveInteger(toolSearch.savedSchemaTokens);
  const searchCount = readPositiveInteger(toolSearch.searchCount);
  const describeCount = readPositiveInteger(toolSearch.describeCount);
  const callCount = readPositiveInteger(toolSearch.callCount);

  if (
    availableToolCount == null ||
    sentToolCount == null ||
    deferredToolCount == null ||
    requestCount == null ||
    catalogSchemaTokens == null ||
    sentSchemaTokens == null ||
    baselineSchemaTokens == null ||
    savedSchemaTokens == null ||
    searchCount == null ||
    describeCount == null ||
    callCount == null
  ) {
    return undefined;
  }

  return {
    mode,
    availableToolCount,
    sentToolCount,
    deferredToolCount,
    requestCount,
    catalogSchemaTokens,
    sentSchemaTokens,
    baselineSchemaTokens,
    savedSchemaTokens,
    searchCount,
    describeCount,
    callCount,
    trace: Array.isArray(toolSearch.trace)
      ? toolSearch.trace.map(readToolSearchTraceEvent).filter(isDefined)
      : [],
  };
}

export function estimateRequestTokenUsage(body: unknown): RequestTokenEstimate | undefined {
  const requestBody = parseRequestBody(body);

  if (!isRecord(requestBody)) {
    return undefined;
  }

  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const systemMessages = messages.filter(isSystemMessage);
  const nonSystemMessages = messages.filter((message) => !isSystemMessage(message));
  const tools = requestBody.tools ?? requestBody.functions;
  const requestOptions = { ...requestBody };

  delete requestOptions.messages;
  delete requestOptions.tools;
  delete requestOptions.functions;

  const toolEstimates = estimateToolSchemas(tools);

  const estimate: RequestTokenEstimate = {
    systemPromptChars: jsonLength(systemMessages),
    messageChars: jsonLength(nonSystemMessages),
    toolChars: jsonLength(tools),
    requestOptionChars: jsonLength(requestOptions),
    messageCount: messages.length,
    toolCount: countItems(tools),
    tools: toolEstimates,
  };

  return estimatePromptChars(estimate) > 0 ? estimate : undefined;
}

export function toTokenUsageBreakdown(
  usage: LanguageModelUsage,
  requestEstimates: RequestTokenEstimate[],
): TokenUsageBreakdown | undefined {
  const aggregate = sumRequestTokenEstimates(requestEstimates);

  if (!aggregate || estimatePromptChars(aggregate) === 0) {
    return undefined;
  }

  const inputTokens = usage.inputTokens;
  const targetTokens = inputTokens ?? estimateTokensFromChars(estimatePromptChars(aggregate));
  const categories = allocateCategoryTokens(
    [
      {
        id: "systemPrompt",
        label: "System instructions",
        chars: aggregate.systemPromptChars,
      },
      {
        id: "tools",
        label: "Tool definitions",
        chars: aggregate.toolChars,
      },
      {
        id: "messages",
        label: "Conversation",
        chars: aggregate.messageChars,
      },
    ],
    targetTokens,
  );
  const toolCategory = categories.find((category) => category.id === "tools");
  const tools = allocateToolTokens(aggregate.tools, toolCategory?.tokens ?? 0);

  return {
    inputTokens,
    estimated: true,
    requestCount: requestEstimates.length,
    messageCount: aggregate.messageCount,
    toolCount: aggregate.toolCount,
    excludedRequestOptionChars: aggregate.requestOptionChars,
    excludedRequestOptionTokens:
      aggregate.requestOptionChars > 0 ? estimateTokensFromChars(aggregate.requestOptionChars) : 0,
    categories,
    tools,
  };
}

export function sumTokenUsages(usages: Iterable<TokenUsage | undefined>): TokenUsage {
  let total: TokenUsage = {};

  for (const usage of usages) {
    if (!usage) {
      continue;
    }

    total = {
      inputTokens: addTokenCounts(total.inputTokens, usage.inputTokens),
      outputTokens: addTokenCounts(total.outputTokens, usage.outputTokens),
      reasoningTokens: addTokenCounts(total.reasoningTokens, usage.reasoningTokens),
      cachedInputTokens: addTokenCounts(total.cachedInputTokens, usage.cachedInputTokens),
      totalTokens: addTokenCounts(total.totalTokens, usage.totalTokens),
    };
  }

  return total;
}

export function formatTokenCount(value: number | undefined) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export function formatTokenPercentage(value: number | undefined) {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value && value < 1 ? 1 : 0,
  }).format(value ?? 0)}%`;
}

function allocateCategoryTokens(
  categories: Array<{
    id: TokenUsageBreakdownCategoryId;
    label: string;
    chars: number;
  }>,
  targetTokens: number,
): TokenUsageBreakdownCategory[] {
  const visibleCategories = categories.filter((category) => category.chars > 0);
  const totalChars = visibleCategories.reduce((sum, category) => sum + category.chars, 0);

  if (totalChars === 0 || targetTokens <= 0) {
    return [];
  }

  const allocations = visibleCategories.map((category) => {
    const exactTokens = (category.chars / totalChars) * targetTokens;
    const tokens = Math.floor(exactTokens);

    return {
      ...category,
      exactTokens,
      tokens,
    };
  });
  let remainingTokens =
    targetTokens - allocations.reduce((sum, category) => sum + category.tokens, 0);

  for (const category of [...allocations].sort(
    (first, second) =>
      second.exactTokens -
      Math.floor(second.exactTokens) -
      (first.exactTokens - Math.floor(first.exactTokens)),
  )) {
    if (remainingTokens <= 0) {
      break;
    }

    category.tokens += 1;
    remainingTokens -= 1;
  }

  return allocations
    .map(({ exactTokens: _exactTokens, ...category }) => ({
      ...category,
      percentage: targetTokens > 0 ? (category.tokens / targetTokens) * 100 : 0,
    }))
    .sort((first, second) => second.tokens - first.tokens);
}

function allocateToolTokens(
  tools: RequestToolEstimate[],
  targetTokens: number,
): TokenUsageToolBreakdown[] {
  const visibleTools = tools.filter((tool) => tool.chars > 0);
  const totalChars = visibleTools.reduce((sum, tool) => sum + tool.chars, 0);

  if (totalChars === 0 || targetTokens <= 0) {
    return [];
  }

  const allocations = visibleTools.map((tool) => {
    const exactTokens = (tool.chars / totalChars) * targetTokens;
    const tokens = Math.floor(exactTokens);

    return {
      ...tool,
      exactTokens,
      tokens,
    };
  });
  let remainingTokens = targetTokens - allocations.reduce((sum, tool) => sum + tool.tokens, 0);

  for (const tool of [...allocations].sort(
    (first, second) =>
      second.exactTokens -
      Math.floor(second.exactTokens) -
      (first.exactTokens - Math.floor(first.exactTokens)),
  )) {
    if (remainingTokens <= 0) {
      break;
    }

    tool.tokens += 1;
    remainingTokens -= 1;
  }

  return allocations
    .map(({ exactTokens: _exactTokens, ...tool }) => ({
      ...tool,
      percentage: targetTokens > 0 ? (tool.tokens / targetTokens) * 100 : 0,
    }))
    .sort((first, second) => second.tokens - first.tokens || first.name.localeCompare(second.name));
}

function compactTokenUsage(usage: TokenUsage): TokenUsage {
  return Object.fromEntries(
    Object.entries(usage).filter((entry): entry is [keyof TokenUsage, number] => {
      const value = entry[1];

      return typeof value === "number" && Number.isFinite(value);
    }),
  );
}

function addTokenCounts(first: number | undefined, second: number | undefined): number | undefined {
  return first == null && second == null ? undefined : (first ?? 0) + (second ?? 0);
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readBreakdownCategory(value: unknown): TokenUsageBreakdownCategory | undefined {
  if (!isRecord(value) || !isBreakdownCategoryId(value.id)) {
    return undefined;
  }

  const tokens = readTokenCount(value.tokens);
  const percentage = readTokenCount(value.percentage);
  const chars = readTokenCount(value.chars);

  if (tokens == null || percentage == null || chars == null) {
    return undefined;
  }

  return {
    id: value.id,
    label: typeof value.label === "string" ? value.label : value.id,
    tokens,
    percentage,
    chars,
  };
}

function readToolBreakdown(value: unknown): TokenUsageToolBreakdown | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }

  const tokens = readTokenCount(value.tokens);
  const percentage = readTokenCount(value.percentage);
  const chars = readTokenCount(value.chars);

  if (tokens == null || percentage == null || chars == null) {
    return undefined;
  }

  return {
    name: value.name,
    tokens,
    percentage,
    chars,
  };
}

function isBreakdownCategoryId(value: unknown): value is TokenUsageBreakdownCategoryId {
  return value === "systemPrompt" || value === "messages" || value === "tools";
}

function parseRequestBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function isSystemMessage(value: unknown): value is { role: "system" } {
  return isRecord(value) && value.role === "system";
}

function jsonLength(value: unknown): number {
  if (value == null) {
    return 0;
  }

  if (Array.isArray(value) && value.length === 0) {
    return 0;
  }

  if (isRecord(value) && Object.keys(value).length === 0) {
    return 0;
  }

  return JSON.stringify(value).length;
}

function countItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (isRecord(value)) {
    return Object.keys(value).length;
  }

  return value == null ? 0 : 1;
}

function estimateToolSchemas(value: unknown): RequestToolEstimate[] {
  if (Array.isArray(value)) {
    return value.map((toolSchema, index) => ({
      chars: jsonLength(toolSchema),
      name: readToolName(toolSchema) ?? `tool_${index + 1}`,
    }));
  }

  if (isRecord(value)) {
    return Object.entries(value).map(([key, toolSchema]) => ({
      chars: jsonLength({ [key]: toolSchema }),
      name: readToolName(toolSchema) ?? key,
    }));
  }

  return [];
}

function readToolName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.name === "string" && value.name.trim()) {
    return value.name;
  }

  if (isRecord(value.function) && typeof value.function.name === "string") {
    const name = value.function.name.trim();

    return name || undefined;
  }

  return undefined;
}

function estimatePromptChars(estimate: RequestTokenEstimate) {
  return estimate.systemPromptChars + estimate.messageChars + estimate.toolChars;
}

function sumRequestTokenEstimates(
  estimates: RequestTokenEstimate[],
): RequestTokenEstimate | undefined {
  if (estimates.length === 0) {
    return undefined;
  }

  return estimates.reduce<RequestTokenEstimate>(
    (total, estimate) => ({
      systemPromptChars: total.systemPromptChars + estimate.systemPromptChars,
      messageChars: total.messageChars + estimate.messageChars,
      toolChars: total.toolChars + estimate.toolChars,
      requestOptionChars: total.requestOptionChars + estimate.requestOptionChars,
      messageCount: total.messageCount + estimate.messageCount,
      toolCount: Math.max(total.toolCount, estimate.toolCount),
      tools: sumToolEstimates(total.tools, estimate.tools),
    }),
    {
      systemPromptChars: 0,
      messageChars: 0,
      toolChars: 0,
      requestOptionChars: 0,
      messageCount: 0,
      toolCount: 0,
      tools: [],
    },
  );
}

function sumToolEstimates(
  first: RequestToolEstimate[],
  second: RequestToolEstimate[],
): RequestToolEstimate[] {
  const byName = new Map<string, number>();

  for (const tool of [...first, ...second]) {
    byName.set(tool.name, (byName.get(tool.name) ?? 0) + tool.chars);
  }

  return Array.from(byName, ([name, chars]) => ({ name, chars }));
}

export function estimateTokensFromChars(chars: number) {
  if (chars <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(chars / 4));
}

function readToolSearchTraceEvent(value: unknown): ToolSearchTraceEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.kind === "search") {
    const query = typeof value.query === "string" ? value.query : "";
    const limit = readPositiveInteger(value.limit);
    const totalAvailable = readPositiveInteger(value.totalAvailable);

    if (!query || limit == null || totalAvailable == null) {
      return undefined;
    }

    return {
      kind: "search",
      query,
      limit,
      totalAvailable,
      matches: Array.isArray(value.matches)
        ? value.matches.map(readToolSearchMatch).filter(isDefined)
        : [],
    };
  }

  if (value.kind === "describe") {
    const name = typeof value.name === "string" ? value.name : "";

    if (!name || typeof value.found !== "boolean") {
      return undefined;
    }

    return {
      kind: "describe",
      name,
      found: value.found,
      service: typeof value.service === "string" ? value.service : undefined,
      title: typeof value.title === "string" ? value.title : undefined,
    };
  }

  if (value.kind === "call") {
    const name = typeof value.name === "string" ? value.name : "";

    if (!name || typeof value.found !== "boolean") {
      return undefined;
    }

    return {
      action: typeof value.action === "string" ? value.action : undefined,
      found: value.found,
      kind: "call",
      name,
      service: typeof value.service === "string" ? value.service : undefined,
      title: typeof value.title === "string" ? value.title : undefined,
    };
  }

  return undefined;
}

function readToolSearchMatch(value: unknown): ToolSearchMatch | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = typeof value.name === "string" ? value.name : "";
  const title = typeof value.title === "string" ? value.title : "";
  const service = typeof value.service === "string" ? value.service : "";
  const score = readTokenCount(value.score);

  if (!name || !title || !service || score == null) {
    return undefined;
  }

  return { name, score, service, title };
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
