"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AlertCircle, CalendarClock, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { ModelPicker } from "@/components/chat/model-picker";
import type { ChatUsageSummary } from "@/components/chat/token-usage-menu";
import { Button } from "@/components/ui/button";
import { useSessionStream } from "@/lib/hooks/use-session-stream";
import type { OpenRouterModelSummary } from "@/lib/models/openrouter";
import type { SkillCatalogEntry } from "@/lib/skills/catalog";
import { parsePartialSkillCommand, parseSkillCommand } from "@/lib/skills/slash-command";
import {
  type ChatMessageMetadata,
  getTokenUsage,
  getTokenUsageBreakdown,
  getToolSearchMetadata,
  sumTokenUsages,
} from "@/lib/token-usage";

const BUSY_STATUSES = new Set(["submitted", "streaming"]);
/** Persists the composer's model choice across reloads (per browser, MVP). */
const MODEL_STORAGE_KEY = "chat:selected-model";
// Shared horizontal framing for the conversation and composer: same centered
// column and gutters the rest of the app uses (max-w-7xl + px-4/8/10).
const SHELL_COLUMN = "mx-auto w-full max-w-7xl px-4 sm:px-8 lg:px-10";
type ChatMessage = UIMessage<ChatMessageMetadata>;

export type ChatSurfaceProps = {
  sessionId: string;
  initialMessages: ChatMessage[];
  /** Stream finished (or aborted): the shell refreshes the session list. */
  onConversationUpdated: () => void;
  /** Reports streaming state up so the shell can guard session switches. */
  onBusyChange: (busy: boolean) => void;
  /** Reports the running token totals up so the shell header can show them. */
  onUsageChange: (usage: ChatUsageSummary) => void;
};

export function ChatSurface({
  sessionId,
  initialMessages,
  onConversationUpdated,
  onBusyChange,
  onUsageChange,
}: ChatSurfaceProps) {
  const [input, setInput] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Holds the latest picked model so the once-constructed transport closure
  // below reads a fresh value on submit AND regenerate (a per-call sendMessage
  // body is dropped on regenerate; this ref is the single source of truth).
  const modelRef = useRef<string | null>(null);
  // Keyed by sessionId at the call site, so a session switch remounts this
  // component and useChat re-seeds from the new id + initialMessages.
  const { messages, sendMessage, setMessages, status, error, stop, regenerate } =
    useChat<ChatMessage>({
      id: sessionId,
      messages: initialMessages,
      // Server-authoritative + append-only: send only the newest message, not the
      // whole transcript. The server reconstructs history from the durable store
      // and appends, so the scheduled-task worker can write the same session
      // without the client clobbering it on the next turn. On regenerate the SDK
      // has already sliced its local array to the fork, so its last message tells
      // the server where to truncate.
      transport: new DefaultChatTransport<ChatMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ id, messages: outgoing, trigger, messageId }) => ({
          body: {
            id,
            trigger,
            messageId,
            message: outgoing[outgoing.length - 1],
            model: modelRef.current ?? undefined,
          },
        }),
      }),
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

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [models, setModels] = useState<OpenRouterModelSummary[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelsRequested = useRef(false);

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
  // useChat hands back a new `messages` array reference on essentially every
  // render during streaming, so memoizing on `messages` alone produces a fresh
  // summary object each time — even though the token numbers only move when a
  // turn finishes (that's when usage lands in metadata). A fresh object identity
  // made the "surface usage" effect below call onUsageChange → re-render the
  // shell → re-render us → recompute → call again …, an infinite loop React
  // aborts with "Maximum update depth exceeded". Preserve the prior identity
  // whenever the content is unchanged so the effect only fires on a real change.
  const usageRef = useRef<ChatUsageSummary>({ sessionUsage: {} });
  const usageSignatureRef = useRef<string>("");

  // Two async writers feed useChat's message list: the SDK's own streaming and
  // the SSE/poll live-merge (applyLiveMessages). When a scheduled round lands
  // mid-turn (e.g. the user asks to stop while a round is firing), the same
  // assistant turn can briefly appear from both writers before they reconcile.
  // Dedupe by id here — the single read boundary — so React always sees unique
  // keys (a duplicate key crashes the list render). First occurrence wins to
  // keep each message at the position where it first appeared.
  const renderedMessages = useMemo<ChatMessage[]>(() => {
    const seen = new Set<string>();
    return messages.filter((message) => {
      if (seen.has(message.id)) {
        return false;
      }
      seen.add(message.id);
      return true;
    });
  }, [messages]);

  const tokenUsageSummary = useMemo<ChatUsageSummary>(() => {
    const assistantMessages = renderedMessages.filter((message) => message.role === "assistant");
    const latestAssistantMessage = assistantMessages.at(-1);

    const next: ChatUsageSummary = {
      latestBreakdown: getTokenUsageBreakdown(latestAssistantMessage?.metadata),
      latestToolSearch: getToolSearchMetadata(latestAssistantMessage?.metadata),
      latestUsage: getTokenUsage(latestAssistantMessage?.metadata),
      sessionUsage: sumTokenUsages(
        assistantMessages.map((message) => getTokenUsage(message.metadata)),
      ),
    };

    const signature = JSON.stringify(next);
    if (signature === usageSignatureRef.current) {
      return usageRef.current;
    }
    usageSignatureRef.current = signature;
    usageRef.current = next;
    return next;
  }, [renderedMessages]);

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

  // Live updates (Phase 3.2): turns appended to this session by the other writer
  // — the scheduled-task worker — arrive via SSE and are merged in. Dedupe by id
  // because the tab already holds its own turns locally (and a NOTIFY re-drain
  // can re-deliver one). Returning the same array reference when nothing is new
  // lets React bail out of the re-render.
  const applyLiveMessages = useCallback(
    (incoming: ChatMessage[]) => {
      if (incoming.length === 0) {
        return;
      }
      setMessages((current) => {
        const seen = new Set(current.map((message) => message.id));
        const additions = incoming.filter((message) => message.id && !seen.has(message.id));
        return additions.length === 0 ? current : [...current, ...additions];
      });
    },
    [setMessages],
  );
  useSessionStream(sessionId, applyLiveMessages);

  // Mirror the streaming state up so the shell can block session switches.
  useEffect(() => {
    onBusyChange(isBusy);
  }, [isBusy, onBusyChange]);

  // Surface the running token totals to the shell header.
  useEffect(() => {
    onUsageChange(tokenUsageSummary);
  }, [tokenUsageSummary, onUsageChange]);

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

  // Restore the previously picked model on mount (per-browser MVP persistence).
  useEffect(() => {
    const stored = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (stored) {
      setSelectedModel(stored);
    }
  }, []);

  // Mirror the picked model into the ref the transport reads (see modelRef).
  // An effect (not a render-phase write) so it only runs on committed renders.
  useEffect(() => {
    modelRef.current = selectedModel;
  }, [selectedModel]);

  // The catalog is large and only needed once the picker opens, so fetch it
  // lazily on first open. Best-effort: the picker falls back to the default.
  const loadModels = useCallback(() => {
    if (modelsRequested.current) {
      return;
    }

    modelsRequested.current = true;
    setModelsLoading(true);
    fetch("/api/models")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Models request failed with status ${response.status}`);
        }
        return response.json();
      })
      .then((data: { models?: OpenRouterModelSummary[]; defaultModel?: string | null }) => {
        if (Array.isArray(data?.models)) {
          setModels(data.models);
        }
        if (data?.defaultModel) {
          setDefaultModel(data.defaultModel);
        }
      })
      .catch(() => {
        // Best-effort: allow a later open to retry after a transient failure.
        modelsRequested.current = false;
      })
      .finally(() => setModelsLoading(false));
  }, []);

  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, modelId);
    } catch {
      // localStorage can be unavailable (private mode); selection still applies.
    }
  }, []);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className={`${SHELL_COLUMN} py-6 sm:py-10`} ref={contentRef}>
          {renderedMessages.length === 0 ? (
            <ConversationEmptyState title="How can I help?" />
          ) : (
            renderedMessages.map((message) => {
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
              const isScheduled =
                message.role === "assistant" && message.metadata?.origin === "scheduled";
              const scheduledRound = isScheduled ? message.metadata?.scheduledRound : undefined;

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
                    {isScheduled ? (
                      <div className="mb-1.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          <CalendarClock aria-hidden="true" className="size-3" />
                          {typeof scheduledRound === "number"
                            ? `Ran scheduled task · round ${scheduledRound}`
                            : "Ran scheduled task"}
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

        {renderedMessages.length > 2 ? (
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

      <div className="shrink-0 bg-background/95 py-3 backdrop-blur sm:py-5">
        <div className={`relative ${SHELL_COLUMN}`}>
          {error ? (
            <div
              className="mb-3 flex items-start gap-3 rounded-lg border border-destructive/30 bg-background px-4 py-3 text-sm text-destructive shadow-sm"
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
              className="pb-12"
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
            <div className="absolute bottom-3 left-3">
              <ModelPicker
                defaultModel={defaultModel}
                loading={modelsLoading}
                models={models}
                onChange={handleModelChange}
                onOpen={loadModels}
                value={selectedModel}
              />
            </div>
            <PromptInputSubmit disabled={!canSubmit} onStop={stop} status={status} />
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
