"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AlertCircle, Zap } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageReasoning,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { SiteNav } from "@/components/site-nav";
import { TasksPanel } from "@/components/tasks-panel";
import { Button } from "@/components/ui/button";
import type { SkillCatalogEntry } from "@/lib/skills/catalog";
import { parsePartialSkillCommand, parseSkillCommand } from "@/lib/skills/slash-command";
import {
  type ChatMessageMetadata,
  formatTokenCount,
  formatTokenPercentage,
  getTokenUsage,
  getTokenUsageBreakdown,
  getToolSearchMetadata,
  sumTokenUsages,
  type TokenUsage,
  type TokenUsageBreakdown,
  type ToolSearchMetadata,
  type ToolSearchTraceEvent,
} from "@/lib/token-usage";

const BUSY_STATUSES = new Set(["submitted", "streaming"]);
// Shared horizontal anchoring for the fixed shell layers. They must share the
// same left anchor (rail on mobile, panel on sm+) and transition timing, or the
// header/conversation/composer drift apart mid-collapse. Each layer appends its
// own vertical edges, z-index, and surface fill.
const SHELL_INSET =
  "fixed right-0 left-[var(--sidebar-rail)] px-4 transition-[left] duration-200 ease-out sm:left-[var(--sidebar-width)] sm:px-8 lg:px-10";
type ChatMessage = UIMessage<ChatMessageMetadata>;
type ChatShellStyle = CSSProperties & {
  "--composer-height"?: string;
  "--header-height"?: string;
};

export type ChatSurfaceProps = {
  sessionId: string;
  initialMessages: ChatMessage[];
  /** Stream finished (or aborted): the shell refreshes the session list. */
  onConversationUpdated: () => void;
  /** Reports streaming state up so the shell can guard session switches. */
  onBusyChange: (busy: boolean) => void;
};

export function ChatSurface({
  sessionId,
  initialMessages,
  onConversationUpdated,
  onBusyChange,
}: ChatSurfaceProps) {
  const [input, setInput] = useState("");
  const [composerRef, composerHeight] = useMeasuredHeight<HTMLDivElement>();
  const [headerRef, headerHeight] = useMeasuredHeight<HTMLElement>();
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Keyed by sessionId at the call site, so a session switch remounts this
  // component and useChat re-seeds from the new id + initialMessages.
  const { messages, sendMessage, status, error, stop, regenerate } = useChat<ChatMessage>({
    id: sessionId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    // onFinish fires on success, abort, AND error. The server only persists a
    // clean finish (route skips isAborted / finishReason === "error"), so only
    // refresh the sidebar when there is something new to show.
    onFinish: ({ isAbort, isError }) => {
      if (!isAbort && !isError) {
        onConversationUpdated();
      }
    },
  });
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogEntry[]>([]);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [lastSkillQuery, setLastSkillQuery] = useState<string | null>(null);
  const skillCatalogRequested = useRef(false);

  const isBusy = BUSY_STATUSES.has(status);
  const canSubmit = input.trim().length > 0 && !isBusy;
  const skillQuery = parsePartialSkillCommand(input);
  const skillMatches = useMemo(
    () =>
      skillQuery === null ? [] : skillCatalog.filter((skill) => skill.name.startsWith(skillQuery)),
    [skillCatalog, skillQuery],
  );
  const isSkillMenuOpen = skillQuery !== null && skillMatches.length > 0 && !skillMenuDismissed;
  const highlightedSkillIndex = Math.min(activeSkillIndex, Math.max(skillMatches.length - 1, 0));

  // Render-time state adjustment (not an effect): a changed command resets the
  // highlight and un-dismisses the menu.
  if (skillQuery !== lastSkillQuery) {
    setLastSkillQuery(skillQuery);
    setSkillMenuDismissed(false);
    setActiveSkillIndex(0);
  }
  const tokenUsageSummary = useMemo(() => {
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    const latestAssistantMessage = assistantMessages.at(-1);

    return {
      latestBreakdown: getTokenUsageBreakdown(latestAssistantMessage?.metadata),
      latestToolSearch: getToolSearchMetadata(latestAssistantMessage?.metadata),
      latestUsage: getTokenUsage(latestAssistantMessage?.metadata),
      sessionUsage: sumTokenUsages(
        assistantMessages.map((message) => getTokenUsage(message.metadata)),
      ),
    };
  }, [messages]);
  const shellStyle = useMemo<ChatShellStyle | undefined>(
    () =>
      composerHeight === null && headerHeight === null
        ? undefined
        : {
            ...(composerHeight === null ? {} : { "--composer-height": `${composerHeight}px` }),
            ...(headerHeight === null ? {} : { "--header-height": `${headerHeight}px` }),
          },
    [composerHeight, headerHeight],
  );

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const inputElement = inputRef.current;

      if (!inputElement || inputElement.disabled) {
        return;
      }

      inputElement.focus();
      inputElement.setSelectionRange(inputElement.value.length, inputElement.value.length);
    });
  }, []);

  // Mirror the streaming state up so the shell can block session switches.
  useEffect(() => {
    onBusyChange(isBusy);
  }, [isBusy, onBusyChange]);

  useEffect(() => {
    const content = contentRef.current;

    if (!content) {
      return;
    }

    content.scrollTo({
      top: content.scrollHeight,
      behavior: "smooth",
    });
  });

  useEffect(() => {
    if (!isBusy) {
      focusInput();
    }
  }, [focusInput, isBusy]);

  // The catalog is only needed once the user starts a /command, so fetch it
  // lazily on the first slash. Autocomplete is best-effort: commands still
  // work without it.
  useEffect(() => {
    if (skillQuery === null || skillCatalogRequested.current) {
      return;
    }

    skillCatalogRequested.current = true;
    fetch("/api/skills/catalog")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { skills?: SkillCatalogEntry[] } | null) => {
        if (Array.isArray(data?.skills)) {
          setSkillCatalog(data.skills);
        }
      })
      .catch(() => {});
  }, [skillQuery]);

  const acceptSkill = useCallback(
    (name: string) => {
      setInput(`/${name} `);
      focusInput();
    },
    [focusInput],
  );

  function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();

    if (!text || isBusy) {
      focusInput();
      return;
    }

    const activatedSkill = parseSkillCommand(text);

    sendMessage(activatedSkill ? { text, metadata: { activatedSkill } } : { text });
    setInput("");
  }

  return (
    <div
      className="[--composer-height:8.75rem] [--header-height:4.5rem] sm:[--composer-height:10.125rem]"
      style={shellStyle}
    >
      <header
        className={`${SHELL_INSET} top-0 z-30 bg-background/95 py-3 backdrop-blur sm:py-4`}
        ref={headerRef}
      >
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">AI SDK App</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
              <span>{isBusy ? "Responding" : "Ready"}</span>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <SiteNav />
            <TasksPanel />
            <TokenUsageMenu
              latestBreakdown={tokenUsageSummary.latestBreakdown}
              latestToolSearch={tokenUsageSummary.latestToolSearch}
              latestUsage={tokenUsageSummary.latestUsage}
              sessionUsage={tokenUsageSummary.sessionUsage}
            />
          </div>
        </div>
      </header>

      <Conversation
        className={`${SHELL_INSET} bottom-[var(--composer-height)] top-[var(--header-height)]`}
      >
        <ConversationContent className="mx-auto w-full max-w-7xl py-6 sm:py-10" ref={contentRef}>
          {messages.length === 0 ? (
            <ConversationEmptyState title="How can I help?" />
          ) : (
            messages.map((message) => {
              const reasoningText = message.parts
                .filter((part) => part.type === "reasoning")
                .map((part) => part.text.trim())
                .filter(Boolean)
                .join("\n\n");
              const responseText = message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n\n");
              const hasResponseText = responseText.trim().length > 0;
              const isReasoningStreaming = message.parts.some(
                (part) => part.type === "reasoning" && part.state === "streaming",
              );
              const activatedSkill =
                message.role === "user" ? message.metadata?.activatedSkill : undefined;

              return (
                <Message from={message.role} key={message.id}>
                  <MessageContent from={message.role}>
                    {activatedSkill ? (
                      <div className="mb-1.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-medium">
                          <Zap aria-hidden="true" className="size-3" />
                          {activatedSkill}
                        </span>
                      </div>
                    ) : null}
                    {reasoningText ? (
                      <MessageReasoning open={isReasoningStreaming && !hasResponseText}>
                        {reasoningText}
                      </MessageReasoning>
                    ) : null}
                    {hasResponseText ? (
                      <MessageResponse className={reasoningText ? "mt-3" : undefined}>
                        {responseText}
                      </MessageResponse>
                    ) : null}
                  </MessageContent>
                </Message>
              );
            })
          )}

          {status === "submitted" ? (
            <Message from="assistant">
              <MessageContent from="assistant">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <span className="size-2 animate-pulse rounded-full bg-primary" />
                  Connecting...
                </span>
              </MessageContent>
            </Message>
          ) : null}
        </ConversationContent>

        {messages.length > 2 ? (
          <ConversationScrollButton
            className="bottom-4"
            onClick={() => {
              contentRef.current?.scrollTo({
                top: contentRef.current.scrollHeight,
                behavior: "smooth",
              });
            }}
          />
        ) : null}
      </Conversation>

      {error ? (
        <div
          className="fixed bottom-[calc(var(--composer-height)+0.75rem)] right-4 left-[calc(var(--sidebar-rail)+1rem)] z-50 flex items-start gap-3 rounded-lg border border-destructive/30 bg-background px-4 py-3 text-sm text-destructive shadow-lg sm:left-[calc(var(--sidebar-width)+2rem)] sm:right-8 lg:left-[calc(var(--sidebar-width)+2.5rem)] lg:right-10"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Chat request failed</p>
            <p className="mt-1 break-words text-destructive/80">{error.message}</p>
          </div>
          <Button onClick={() => regenerate()} size="sm" type="button" variant="outline">
            Retry
          </Button>
        </div>
      ) : null}

      <div
        className={`${SHELL_INSET} bottom-0 z-40 bg-background/95 py-3 backdrop-blur sm:py-5`}
        ref={composerRef}
      >
        <div className="relative mx-auto w-full max-w-7xl">
          {isSkillMenuOpen ? (
            <div
              aria-label="Skills"
              className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full max-w-md overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-lg"
              role="listbox"
            >
              {skillMatches.map((skill, index) => (
                <button
                  aria-selected={index === highlightedSkillIndex}
                  className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
                    index === highlightedSkillIndex ? "bg-muted" : "hover:bg-muted/60"
                  }`}
                  key={skill.id}
                  onClick={() => acceptSkill(skill.name)}
                  role="option"
                  type="button"
                >
                  <span className="shrink-0 font-medium text-foreground">/{skill.name}</span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {skill.description}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputTextarea
              aria-label="Message"
              disabled={isBusy}
              ref={inputRef}
              onKeyDown={(event) => {
                if (isSkillMenuOpen) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    setActiveSkillIndex(
                      (highlightedSkillIndex + delta + skillMatches.length) % skillMatches.length,
                    );
                    return;
                  }

                  if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                    event.preventDefault();
                    acceptSkill(skillMatches[highlightedSkillIndex].name);
                    return;
                  }

                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSkillMenuDismissed(true);
                    return;
                  }
                }

                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onChange={(event) => setInput(event.currentTarget.value)}
              placeholder="Send a message... (/skill-name to activate a skill)"
              value={input}
            />
            <PromptInputSubmit disabled={!canSubmit} onStop={stop} status={status} />
          </PromptInput>
        </div>
      </div>
    </div>
  );
}

function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;

    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      setHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
    };
    const observer = new ResizeObserver(updateHeight);

    updateHeight();
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [ref, height] as const;
}

function TokenUsageMenu({
  latestBreakdown,
  latestToolSearch,
  latestUsage,
  sessionUsage,
}: {
  latestBreakdown?: TokenUsageBreakdown;
  latestToolSearch?: ToolSearchMetadata;
  latestUsage?: TokenUsage;
  sessionUsage: TokenUsage;
}) {
  return (
    <details className="relative shrink-0 text-right">
      <summary className="-mr-2 block cursor-pointer list-none rounded-md px-2 py-1 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary/30 [&::-webkit-details-marker]:hidden">
        <span className="block text-xs text-muted-foreground">Session tokens</span>
        <span className="block tabular-nums text-sm font-semibold text-foreground">
          {formatTokenCount(sessionUsage.totalTokens)}
        </span>
      </summary>
      <div className="absolute right-0 top-full z-20 mt-3 w-[min(calc(100vw-2rem),34rem)] rounded-lg border border-border bg-background p-4 text-left shadow-[0_24px_70px_-36px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Last request</p>
            <p className="mt-1 text-xs text-muted-foreground">
              OpenRouter totals are exact. The input split estimates model-readable content.
            </p>
          </div>
          <p className="shrink-0 tabular-nums text-sm font-semibold text-foreground">
            {formatTokenCount(latestUsage?.totalTokens)}
          </p>
        </div>

        {latestUsage ? <ProviderUsageGrid usage={latestUsage} /> : null}
        {latestBreakdown ? <PromptAllocation breakdown={latestBreakdown} /> : null}
        {latestToolSearch ? <ToolSearchPanel metadata={latestToolSearch} /> : null}

        {!latestUsage ? (
          <p className="mt-4 text-xs text-muted-foreground">Send a message to see usage.</p>
        ) : null}
      </div>
    </details>
  );
}

function ToolSearchPanel({ metadata }: { metadata: ToolSearchMetadata }) {
  const modeLabel = metadata.mode === "search" ? "Search bridge" : "All tools";
  const rows = [
    {
      label: "Catalog",
      value: `${formatTokenCount(metadata.availableToolCount)} tools`,
    },
    {
      label: "Sent",
      value: `${formatTokenCount(metadata.sentToolCount)} tools`,
    },
    {
      label: "Schema sent",
      value: `${formatTokenCount(metadata.sentSchemaTokens)} tokens`,
    },
    {
      label: "Saved",
      value: `${formatTokenCount(metadata.savedSchemaTokens)} tokens`,
    },
  ];

  return (
    <div className="mt-4 rounded-md border border-border/80 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Tool search</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {modeLabel} · {metadata.requestCount} request
            {metadata.requestCount === 1 ? "" : "s"}
          </p>
        </div>
        <p className="shrink-0 text-[11px] text-muted-foreground">
          baseline {formatTokenCount(metadata.baselineSchemaTokens)}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {rows.map((row) => (
          <div className="rounded-md bg-muted/45 px-2.5 py-2" key={row.label}>
            <p className="text-[10px] font-medium text-muted-foreground">{row.label}</p>
            <p className="mt-0.5 tabular-nums text-xs font-semibold text-foreground">{row.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        <span>{metadata.searchCount} searches</span>
        <span>{metadata.describeCount} describes</span>
        <span>{metadata.callCount} calls</span>
        <span>{metadata.deferredToolCount} deferred</span>
      </div>

      {metadata.trace.length > 0 ? <ToolSearchTrace trace={metadata.trace} /> : null}
    </div>
  );
}

function ToolSearchTrace({ trace }: { trace: ToolSearchTraceEvent[] }) {
  const visibleTrace = trace.slice(-5);

  return (
    <details className="mt-3 border-t border-border/70 pt-2">
      <summary className="cursor-pointer list-none text-[11px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30 [&::-webkit-details-marker]:hidden">
        Search trace
        <span className="ml-2 font-normal text-muted-foreground">
          latest {visibleTrace.length} of {trace.length}
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        {visibleTrace.map((event) => (
          <div
            className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-[11px]"
            key={`${event.kind}-${getToolSearchEventDetail(event)}`}
          >
            <span className="font-medium text-foreground">{getToolSearchEventLabel(event)}</span>
            <span className="min-w-0 text-muted-foreground">{getToolSearchEventDetail(event)}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function ProviderUsageGrid({ usage }: { usage: TokenUsage }) {
  const rows = [
    {
      description: "Prompt tokens: conversation, instructions, and tool definitions",
      label: "Sent to model",
      value: usage.inputTokens,
    },
    {
      description: "Completion tokens: visible answer plus any thinking",
      label: "Generated output",
      value: usage.outputTokens,
    },
    {
      description: "Reasoning tokens inside generated output",
      label: "Thinking subset",
      value: usage.reasoningTokens,
    },
    {
      description: "Input tokens reused from provider cache",
      label: "Cache read",
      value: usage.cachedInputTokens,
    },
  ];

  return (
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {rows.map((row) => (
        <div
          className="min-h-[5.75rem] rounded-md border border-border/80 px-3 py-2"
          key={row.label}
        >
          <p className="text-[11px] font-medium text-foreground">{row.label}</p>
          <p className="mt-1 tabular-nums text-sm font-semibold text-foreground">
            {formatTokenCount(row.value)}
          </p>
          <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{row.description}</p>
        </div>
      ))}
    </div>
  );
}

function PromptAllocation({ breakdown }: { breakdown: TokenUsageBreakdown }) {
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold text-foreground">Estimated input-token split</p>
        <p className="text-[11px] text-muted-foreground">
          {breakdown.requestCount} request{breakdown.requestCount === 1 ? "" : "s"} ·{" "}
          {breakdown.toolCount} tools
        </p>
      </div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted">
        {breakdown.categories.map((category) => (
          <span
            className={getBreakdownBarColor(category.id)}
            key={category.id}
            style={{
              minWidth: category.tokens > 0 ? 2 : 0,
              width: `${category.percentage}%`,
            }}
          />
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {breakdown.categories.map((category) => {
          const copy = getBreakdownCategoryCopy(category.id, breakdown);

          return (
            <div className="flex items-start justify-between gap-4 text-xs" key={category.id}>
              <span className="flex min-w-0 items-start gap-2">
                <span
                  className={`mt-1 size-2 shrink-0 rounded-sm ${getBreakdownDotColor(category.id)}`}
                />
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">{copy.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    {copy.description}
                  </span>
                </span>
              </span>
              <span className="shrink-0 pt-0.5 tabular-nums text-foreground">
                {formatTokenCount(category.tokens)} · {formatTokenPercentage(category.percentage)}
              </span>
            </div>
          );
        })}
      </div>

      {breakdown.excludedRequestOptionTokens > 0 ? (
        <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
          API options excluded: model, streaming, routing, and generation settings are request
          metadata, not prompt content.
        </p>
      ) : null}

      {breakdown.tools.length > 0 ? <ToolSchemaBreakdown breakdown={breakdown} /> : null}
    </div>
  );
}

function ToolSchemaBreakdown({ breakdown }: { breakdown: TokenUsageBreakdown }) {
  const visibleTools = breakdown.tools.slice(0, 8);
  const hiddenTools = breakdown.tools.slice(8);
  const hiddenTokens = hiddenTools.reduce((sum, tool) => sum + tool.tokens, 0);
  const hiddenPercentage = hiddenTools.reduce((sum, tool) => sum + tool.percentage, 0);

  return (
    <details className="mt-4 rounded-md border border-border/80 px-3 py-2">
      <summary className="cursor-pointer list-none text-xs font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30 [&::-webkit-details-marker]:hidden">
        <span>Tool schema breakdown</span>
        <span className="ml-2 font-normal text-muted-foreground">
          top {visibleTools.length} of {breakdown.tools.length}
        </span>
      </summary>
      <div className="mt-3 space-y-2">
        {visibleTools.map((tool) => (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs" key={tool.name}>
            <span className="min-w-0 truncate text-muted-foreground" title={tool.name}>
              {tool.name}
            </span>
            <span className="shrink-0 tabular-nums text-foreground">
              {formatTokenCount(tool.tokens)} · {formatTokenPercentage(tool.percentage)}
            </span>
          </div>
        ))}
        {hiddenTools.length > 0 ? (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-border/70 pt-2 text-xs">
            <span className="min-w-0 text-muted-foreground">
              Other {hiddenTools.length} tool schemas
            </span>
            <span className="shrink-0 tabular-nums text-foreground">
              {formatTokenCount(hiddenTokens)} · {formatTokenPercentage(hiddenPercentage)}
            </span>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function getToolSearchEventLabel(event: ToolSearchTraceEvent) {
  switch (event.kind) {
    case "search":
      return "Search";
    case "describe":
      return "Describe";
    case "call":
      return "Call";
  }
}

function getToolSearchEventDetail(event: ToolSearchTraceEvent) {
  switch (event.kind) {
    case "search": {
      const names = event.matches
        .slice(0, 3)
        .map((match) => match.name)
        .join(", ");

      return `"${event.query}" -> ${names || "no matches"}`;
    }
    case "describe":
      return event.found ? `${event.name} schema loaded` : `${event.name} not found`;
    case "call":
      return event.found ? `${event.name} invoked` : `${event.name} not found`;
  }
}

function getBreakdownCategoryCopy(
  id: TokenUsageBreakdown["categories"][number]["id"],
  breakdown: TokenUsageBreakdown,
) {
  switch (id) {
    case "tools":
      return {
        description: `${formatTokenCount(breakdown.toolCount)} available tool schemas sent to the provider`,
        label: "Tool definitions",
      };
    case "messages":
      return {
        description: "User, assistant, and tool-result messages in the conversation",
        label: "Conversation",
      };
    case "systemPrompt":
      return {
        description: "Hidden app and system instructions, when present",
        label: "System instructions",
      };
  }
}

function getBreakdownBarColor(id: TokenUsageBreakdown["categories"][number]["id"]) {
  switch (id) {
    case "tools":
      return "bg-amber-500";
    case "messages":
      return "bg-sky-500";
    case "systemPrompt":
      return "bg-violet-500";
  }
}

function getBreakdownDotColor(id: TokenUsageBreakdown["categories"][number]["id"]) {
  switch (id) {
    case "tools":
      return "bg-amber-500";
    case "messages":
      return "bg-sky-500";
    case "systemPrompt":
      return "bg-violet-500";
  }
}
