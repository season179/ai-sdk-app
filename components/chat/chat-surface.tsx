"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AlertCircle, Zap } from "lucide-react";
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
import type { ChatUsageSummary } from "@/components/chat/token-usage-menu";
import { Button } from "@/components/ui/button";
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
  const tokenUsageSummary = useMemo<ChatUsageSummary>(() => {
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

      <div className="shrink-0 border-t border-border/60 bg-background/95 py-3 backdrop-blur sm:py-5">
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
