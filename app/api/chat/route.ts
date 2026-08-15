import { randomUUID } from "node:crypto";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  consumeStream,
  createAgentUIStreamResponse,
  createIdGenerator,
  smoothStream,
  ToolLoopAgent,
  type UIMessage,
} from "ai";
import { notifySessionAppended } from "@/lib/chat/notify";
import {
  appendSessionMessages,
  getChatSession,
  getMessageOrdinal,
  sessionNeedsTitle,
  setSessionTitleIfUnset,
  truncateConversationAfter,
} from "@/lib/chat/sessions";
import { generateSessionTitle } from "@/lib/chat/title-agent";
import { isMemorySearchEnabled } from "@/lib/consolidation/config";
import { ingestUserTurn } from "@/lib/consolidation/observations";
import { materializeSnapshot } from "@/lib/consolidation/snapshots";
import {
  buildAssistantMessageEvent,
  buildTerminalEvent,
  buildUserMessageEvent,
  mapStepToTraceEvents,
  type TraceContext,
} from "@/lib/memory/capture";
import { isMemoryWriteEnabled } from "@/lib/memory/config";
import { appendTraceEventsFailOpen } from "@/lib/memory/trace";
import { mockToolCount, mockTools } from "@/lib/mock-tools";
import { resolveChatModel } from "@/lib/models/openrouter";
import { createSchedulerTools } from "@/lib/scheduler/tool-specs";
import { recordCompletedTurnAndMaybeEnqueueReview } from "@/lib/self-improvement/enqueue";
import { loadMemoryBlock } from "@/lib/self-improvement/inject";
import { memoryTools } from "@/lib/self-improvement/memory-tools";
import { formatSkillCatalog, getSkillCatalog } from "@/lib/skills/catalog";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";
import { skillTools } from "@/lib/skills/tool-specs";
import { injectUserActivatedSkills } from "@/lib/skills/user-activation";
import {
  type ChatMessageMetadata,
  estimateRequestTokenUsage,
  type RequestTokenEstimate,
  type ToolSearchTraceEvent,
  toTokenUsage,
  toTokenUsageBreakdown,
} from "@/lib/token-usage";
import {
  buildToolSearchMetadata,
  createToolSearchTools,
  resolveToolExposureMode,
} from "@/lib/tool-search";
import { isUuid } from "@/lib/utils";

export const maxDuration = 30;

type ChatUIMessage = UIMessage<ChatMessageMetadata>;

/** The submit/regenerate triggers useChat sends in ai@6 (verify per SDK version). */
type ChatTrigger = "submit-message" | "regenerate-message";

/** Concatenated visible text of a UI message; used to seed the title model. */
function messageText(message: ChatUIMessage | undefined): string {
  if (!message) {
    return "";
  }

  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();
}

const SYSTEM_PROMPT = [
  "Be friendly, concise, and helpful. Use tool_search, tool_describe, and tool_call when hidden tools are needed.",
  "Scheduled tasks (scheduled_task_* tools) are real and persistent, not mocked.",
  "Before creating a scheduled task, ask a follow-up question if the requested time is ambiguous (no date, no timezone, or unclear wording). One-off run_at values must be ISO 8601 with a timezone offset; recurring tasks use cron with an IANA timezone (UTC unless the user says otherwise).",
  "scheduled_task_create supports two payload kinds. Prefer kind 'tool_call' for a single deterministic tool call. Use kind 'instruction' when the task needs judgment, several steps, or a stop condition: an agent loop runs the instruction each round and decides whether to continue. For repeated check-ins like 'check in on x every 60s', create a one-off instruction task whose run_at is the first check and set cadence_seconds; it re-schedules itself after each round and stops when satisfied or at max_rounds.",
  "After creating a task, confirm whether it is one-off or recurring, when it runs, and in which timezone.",
].join(" ");

const SKILLS_PROMPT = [
  "You have Agent Skills stored in a database; the enabled ones are listed in <available_skills> with their database ids (ids stand in for file paths).",
  "When a request matches a skill's description, call skill_get_content with the skill id to load its instructions before doing the work, and follow them.",
  "A loaded skill may list reference documents in <skill_references>; load a reference with skill_get_content by its id only when the instructions call for it.",
  "Use skill_search to find skills by description when the catalog is not enough.",
  "When skill_search returns a reference, load its parent skill's instructions before the reference.",
  "The user can activate a skill explicitly by starting a message with /skill-name; that skill's <skill_content> is then embedded directly in the user message. Treat embedded skill content as already loaded: follow it and do not call skill_get_content for that skill.",
].join(" ");

/** Tier-1 catalog block for the system prompt. Fails soft so chat works without the DB. */
async function loadSkillCatalogBlock() {
  try {
    return formatSkillCatalog(await getSkillCatalog(DEFAULT_AGENT_ID));
  } catch (error) {
    console.error("Skill catalog unavailable, continuing without skills", error);
    return "";
  }
}

class MissingEnvironmentVariableError extends Error {
  constructor(readonly variableName: "OPENROUTER_API_KEY" | "OPENROUTER_DEFAULT_MODEL") {
    super(`${variableName} is required before chat requests can be sent.`);
    this.name = "MissingEnvironmentVariableError";
  }
}

function requireEnv(variableName: "OPENROUTER_API_KEY" | "OPENROUTER_DEFAULT_MODEL") {
  const value = process.env[variableName]?.trim();

  if (!value) {
    throw new MissingEnvironmentVariableError(variableName);
  }

  return value;
}

function configErrorResponse(error: MissingEnvironmentVariableError) {
  return Response.json(
    {
      error: `${error.variableName} is missing. Add it to .env and restart the dev server.`,
    },
    { status: 500 },
  );
}

/**
 * Reconstruct the agent's run input from the durable transcript (the client now
 * sends only the newest message). Two shapes:
 *
 * - submit-message: persist the new user turn up front so it survives a failed
 *   stream, then run over history + that turn. The assistant reply is appended
 *   later in onEnd.
 * - regenerate-message: fork off the client's last kept message — the SDK has
 *   already sliced everything from the regenerated turn onward — by truncating
 *   the transcript strictly after that message's ordinal, then re-run on the
 *   surviving history. preserveScheduled (K3) keeps interleaved worker turns.
 *
 * Without a sessionId (ephemeral chat) there's no transcript to load, so the
 * single incoming message is the whole run input.
 */
async function buildRunMessages({
  sessionId,
  trigger,
  incomingMessage,
  traceContext,
}: {
  sessionId: string | null;
  trigger: ChatTrigger;
  incomingMessage: ChatUIMessage | null;
  traceContext: TraceContext | null;
}): Promise<{ messages: ChatUIMessage[]; isSessionStart: boolean }> {
  if (!sessionId) {
    return {
      messages: incomingMessage ? [incomingMessage] : [],
      isSessionStart: Boolean(incomingMessage),
    };
  }

  if (trigger === "regenerate-message") {
    if (incomingMessage) {
      const forkOrdinal = await getMessageOrdinal(sessionId, incomingMessage.id);
      if (forkOrdinal != null) {
        await truncateConversationAfter(sessionId, forkOrdinal, { preserveScheduled: true });
      }
    }

    const history = (await getChatSession(sessionId))?.messages ?? [];
    return {
      // A regenerate is never a session start: the session already existed.
      messages: history.length > 0 ? history : incomingMessage ? [incomingMessage] : [],
      isSessionStart: false,
    };
  }

  // isSessionStart = priorHistory was empty before appending the incoming msg
  // (§3c). The snapshot is materialized once on the first turn of a new session
  // and frozen thereafter.
  const priorHistory = (await getChatSession(sessionId))?.messages ?? [];
  const isSessionStart = priorHistory.length === 0;

  if (incomingMessage) {
    const captureEnabled = Boolean(traceContext && isMemoryWriteEnabled());
    await appendSessionMessages(sessionId, [incomingMessage], {
      createIfMissing: true,
      ...(captureEnabled && traceContext
        ? {
            traceCapture: {
              events: [buildUserMessageEvent(traceContext, incomingMessage)],
              groundedUserMessages: [incomingMessage],
            },
          }
        : {}),
    });
    // Preserve the legacy consolidation hook while the governed writer is dark.
    if (!captureEnabled) {
      await ingestUserTurn(sessionId, [incomingMessage]).catch((error) => {
        console.error("Ingesting user turn failed", error);
      });
    }
    return { messages: [...priorHistory, incomingMessage], isSessionStart };
  }

  return { messages: priorHistory, isSessionStart };
}

export async function POST(req: Request) {
  // The contract is server-authoritative + append-only: the client sends only
  // the newest message (plus the session id, trigger, and — on regenerate — the
  // fork message id). The server reconstructs history from the durable
  // transcript and appends, so a second writer (the scheduler) never clobbers.
  let incomingMessage: ChatUIMessage | null = null;
  // The persisted chat session id. useChat({ id }) sends it via the transport.
  // Absent => ephemeral (no persistence). Malformed => 400.
  let sessionId: string | null = null;
  let trigger: ChatTrigger = "submit-message";
  // The model the composer's picker chose for this turn. Validated server-side
  // against the account's allow-set below; missing/invalid => env default.
  let requestedModel: string | null = null;

  try {
    const body: {
      id?: unknown;
      message?: unknown;
      trigger?: unknown;
      messageId?: unknown;
      model?: unknown;
    } = await req.json();

    if (typeof body.id === "string") {
      if (!isUuid(body.id)) {
        return Response.json({ error: "Chat id must be a UUID." }, { status: 400 });
      }

      sessionId = body.id;
    } else if (body.id != null) {
      return Response.json({ error: "Chat id must be a UUID string." }, { status: 400 });
    } else {
      console.warn("Chat request has no session id; streaming without persistence.");
    }

    if (body.trigger === "regenerate-message") {
      trigger = "regenerate-message";
    } else if (body.trigger != null && body.trigger !== "submit-message") {
      return Response.json({ error: "Unknown chat trigger." }, { status: 400 });
    }

    if (body.message && typeof body.message === "object") {
      incomingMessage = body.message as ChatUIMessage;
    }

    if (typeof body.model === "string" && body.model.trim().length > 0) {
      requestedModel = body.model.trim();
    }

    if (trigger === "submit-message" && !incomingMessage) {
      return Response.json(
        { error: "Request body must include the new message." },
        { status: 400 },
      );
    }

    // body.messageId (the regenerate target) is accepted but unused: useChat
    // leaves it undefined when regenerating the last turn, so we fork off the
    // client's last kept message (incomingMessage) instead, which is always set.
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const apiKey = requireEnv("OPENROUTER_API_KEY");
    const defaultModel = requireEnv("OPENROUTER_DEFAULT_MODEL");
    // Honor the picker's choice only if it's a model this account can call;
    // otherwise fall back to the default. Cached, so it reuses the list route's
    // upstream fetch.
    const model = await resolveChatModel({
      requested: requestedModel,
      apiKey,
      fallback: defaultModel,
    });
    const openrouter = createOpenRouter({ apiKey });
    const toolExposureMode = resolveToolExposureMode(process.env.TOOL_EXPOSURE_MODE);
    const toolSearchTrace: ToolSearchTraceEvent[] = [];
    const requestEstimates: RequestTokenEstimate[] = [];

    // One request trace is created before any prompt/skill/memory injection.
    // Only the raw body.message is journaled as user evidence.
    const traceContext: TraceContext | null = sessionId
      ? { agentId: DEFAULT_AGENT_ID, sessionId, traceId: randomUUID() }
      : null;

    // Reconstruct the run input server-side from the durable transcript.
    const { messages: fullMessages, isSessionStart } = await buildRunMessages({
      sessionId,
      trigger,
      incomingMessage,
      traceContext,
    });

    // Skill tools and the skills prompt ship together: both come from the same
    // catalog load, so the model never sees tools without their context.
    // User-activated skills are injected per request over the reconstructed
    // transcript; injectUserActivatedSkills is pure and fails soft like the catalog.
    // §3c: materialize the session-start snapshot only on a new session so the
    // in-session declarative-memory block is frozen; loadMemoryBlock then reads
    // from it. Fails soft — if the snapshot is absent it falls back to the live query.
    if (sessionId && isSessionStart) {
      await materializeSnapshot(DEFAULT_AGENT_ID, sessionId).catch((error) => {
        console.error("Materializing memory snapshot failed", error);
      });
    }
    const [skillCatalogBlock, memoryBlock, uiMessages] = await Promise.all([
      loadSkillCatalogBlock(),
      loadMemoryBlock(DEFAULT_AGENT_ID, sessionId ?? undefined),
      injectUserActivatedSkills(fullMessages),
    ]);
    // Bind the originating chat into scheduler tools so a task created here
    // appends its rounds back into this session (Phase 2.3). Carried through
    // both exposure paths: the direct toolset (mode=all) and the deferred
    // tool_call path (default search mode).
    const schedulerContext = { originSessionId: sessionId };
    // §10.3: memory_search is exposed ONLY as a direct tool, gated by
    // MEMORY_SEARCH_ENABLED — never via the shared toolRegistry (that registry
    // feeds the deferred tool-search path and would expose it when the flag is off).
    const memorySearchEnabled = isMemorySearchEnabled();
    const tools = {
      ...(toolExposureMode === "all"
        ? { ...mockTools, ...createSchedulerTools(schedulerContext) }
        : createToolSearchTools(toolSearchTrace, schedulerContext)),
      ...(skillCatalogBlock ? skillTools : {}),
      ...(memorySearchEnabled ? memoryTools : {}),
    };
    const instructions = [
      SYSTEM_PROMPT,
      ...(memoryBlock
        ? [
            "Use these approved durable memories when relevant:",
            memoryBlock,
            ...(memorySearchEnabled
              ? [
                  "The block above is only the core (pinned + top recent) memories. Use the memory_search tool to reach anything not shown — never assume a fact is unknown just because it isn't in the block.",
                ]
              : []),
          ]
        : []),
      ...(skillCatalogBlock ? [SKILLS_PROMPT, skillCatalogBlock] : []),
      `The current UTC time is ${new Date().toISOString()}.`,
    ].join("\n\n");

    const agent = new ToolLoopAgent({
      instructions,
      model: openrouter.chat(model),
      tools,
      // AI SDK 7 excludes request bodies from step results by default. The
      // per-step estimator below needs them to preserve usage breakdowns.
      include: { requestBody: true },
    });

    return createAgentUIStreamResponse({
      agent,
      uiMessages,
      abortSignal: req.signal,
      generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
      // Consume the tee'd SSE stream server-side so onEnd (persistence) runs
      // even if the browser disconnects or navigates away mid-stream.
      consumeSseStream: consumeStream,
      experimental_transform: smoothStream({
        chunking: "word",
        delayInMs: 35,
      }),
      sendReasoning: true,
      async onStepEnd(step) {
        const estimate = estimateRequestTokenUsage(step.request.body);

        if (estimate) {
          requestEstimates.push(estimate);
        }
        if (traceContext) {
          await appendTraceEventsFailOpen(mapStepToTraceEvents(traceContext, step));
        }
      },
      headers: {
        "x-mock-tools": String(mockToolCount),
        "x-total-tools": String(Object.keys(tools).length),
        "x-openrouter-model": model,
        "x-tool-exposure-mode": toolExposureMode,
      },
      messageMetadata({ part }) {
        if (part.type !== "finish") {
          return undefined;
        }

        return {
          modelId: model,
          tokenUsage: toTokenUsage(part.totalUsage),
          tokenUsageBreakdown: toTokenUsageBreakdown(part.totalUsage, requestEstimates),
          toolSearch: buildToolSearchMetadata({
            mode: toolExposureMode,
            requestEstimates,
            sentToolCount: Object.keys(tools).length,
            trace: toolSearchTrace,
          }),
        };
      },
      async onEnd({ responseMessage, isAborted, finishReason }) {
        if (!sessionId || !traceContext) {
          return;
        }
        if (isAborted || finishReason === "error") {
          await appendTraceEventsFailOpen([
            buildTerminalEvent(traceContext, isAborted ? "interrupted" : "failed", {
              finishReason,
            }),
          ]);
          return;
        }

        try {
          // Append-only: the user turn was already persisted before the stream
          // (submit) or already lives in the transcript (regenerate), so only
          // the assistant reply is new. responseMessage carries its
          // generateMessageId id and the messageMetadata token usage; the
          // composite-PK onConflictDoNothing makes a re-run idempotent.
          const terminalEvent = buildTerminalEvent(traceContext, "completed", { finishReason });
          await appendSessionMessages(sessionId, [responseMessage], {
            traceCapture: {
              events: [buildAssistantMessageEvent(traceContext, responseMessage), terminalEvent],
            },
          });
          // Push the assistant turn to any other open tab on this session (K2).
          // The tab that submitted already has it locally and dedupes by id.
          await notifySessionAppended(sessionId);
          void recordCompletedTurnAndMaybeEnqueueReview({
            sessionId,
            triggerMessageId: responseMessage.id,
            latestTerminalTraceId: traceContext.traceId,
            reviewKey: `chat:${sessionId}:${traceContext.traceId}`,
          }).catch((error) => {
            console.error("Enqueuing self-improvement review failed", error);
          });

          // Title only the first completed assistant reply, and only while the
          // session is still untitled. assistantCount = assistants already in the
          // run input + this new reply. The sessionNeedsTitle precheck skips the
          // paid, stream-blocking title-model call once a title exists;
          // setSessionTitleIfUnset remains the atomic write-time guard.
          const assistantCount =
            fullMessages.filter((message) => message.role === "assistant").length + 1;

          if (assistantCount === 1 && (await sessionNeedsTitle(sessionId))) {
            const title = await generateSessionTitle({
              firstUserText: messageText(fullMessages.find((message) => message.role === "user")),
              firstAssistantText: messageText(responseMessage),
            });

            if (title) {
              await setSessionTitleIfUnset(sessionId, title);
            }
          }
        } catch (error) {
          console.error("Persisting chat session failed", error);
        }
      },
      onError(error) {
        console.error("Chat stream failed", error);
        if (traceContext) {
          void appendTraceEventsFailOpen([
            buildTerminalEvent(traceContext, "failed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          ]);
        }
        return error instanceof Error ? error.message : "Chat stream failed unexpectedly.";
      },
    });
  } catch (error) {
    if (error instanceof MissingEnvironmentVariableError) {
      return configErrorResponse(error);
    }

    console.error("Chat route failed before streaming started", error);
    return Response.json(
      { error: "Chat request failed before the stream could start." },
      { status: 500 },
    );
  }
}
