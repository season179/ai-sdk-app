import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  consumeStream,
  createAgentUIStreamResponse,
  createIdGenerator,
  smoothStream,
  ToolLoopAgent,
  type UIMessage,
} from "ai";

import { saveChatSession, sessionNeedsTitle, setSessionTitleIfUnset } from "@/lib/chat/sessions";
import { generateSessionTitle } from "@/lib/chat/title-agent";
import { mockToolCount, mockTools } from "@/lib/mock-tools";
import { schedulerTools } from "@/lib/scheduler/tool-specs";
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

/** Concatenated visible text of a UI message; used to seed the title model. */
function messageText(message: UIMessage<ChatMessageMetadata> | undefined): string {
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

export async function POST(req: Request) {
  let messages: UIMessage<ChatMessageMetadata>[];
  // The persisted chat session id. useChat({ id }) sends it in the default
  // transport body. Absent => ephemeral (no persistence). Malformed => 400.
  let sessionId: string | null = null;

  try {
    const body: { messages?: UIMessage<ChatMessageMetadata>[]; id?: unknown } = await req.json();

    if (!Array.isArray(body.messages)) {
      return Response.json(
        { error: "Request body must include a messages array." },
        { status: 400 },
      );
    }

    messages = body.messages;

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
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const apiKey = requireEnv("OPENROUTER_API_KEY");
    const model = requireEnv("OPENROUTER_DEFAULT_MODEL");
    const openrouter = createOpenRouter({ apiKey });
    const toolExposureMode = resolveToolExposureMode(process.env.TOOL_EXPOSURE_MODE);
    const toolSearchTrace: ToolSearchTraceEvent[] = [];
    const requestEstimates: RequestTokenEstimate[] = [];
    // Skill tools and the skills prompt ship together: both come from the same
    // catalog load, so the model never sees tools without their context.
    // User-activated skills are injected per request because the client resends
    // the raw transcript; injectUserActivatedSkills fails soft like the catalog.
    const [skillCatalogBlock, uiMessages] = await Promise.all([
      loadSkillCatalogBlock(),
      injectUserActivatedSkills(messages),
    ]);
    const tools = {
      ...(toolExposureMode === "all"
        ? { ...mockTools, ...schedulerTools }
        : createToolSearchTools(toolSearchTrace)),
      ...(skillCatalogBlock ? skillTools : {}),
    };
    const instructions = [
      SYSTEM_PROMPT,
      ...(skillCatalogBlock ? [SKILLS_PROMPT, skillCatalogBlock] : []),
      `The current UTC time is ${new Date().toISOString()}.`,
    ].join("\n\n");

    const agent = new ToolLoopAgent({
      instructions,
      model: openrouter.chat(model),
      tools,
    });

    return createAgentUIStreamResponse({
      agent,
      uiMessages,
      abortSignal: req.signal,
      generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
      // Consume the tee'd SSE stream server-side so onFinish (persistence) runs
      // even if the browser disconnects or navigates away mid-stream.
      consumeSseStream: consumeStream,
      experimental_transform: smoothStream({
        chunking: "word",
        delayInMs: 35,
      }),
      sendReasoning: true,
      onStepFinish(step) {
        const estimate = estimateRequestTokenUsage(step.request.body);

        if (estimate) {
          requestEstimates.push(estimate);
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
      async onFinish({ responseMessage, isAborted, finishReason }) {
        // Fail-soft: a persistence error must never break the stream the client
        // already received. Skip aborted/errored finishes.
        if (!sessionId || isAborted || finishReason === "error") {
          return;
        }

        try {
          // Persist the RAW transcript (not the skill-injected uiMessages) plus
          // the assistant reply. injectUserActivatedSkills is pure, so `messages`
          // is still the clean, user-visible array. responseMessage carries its
          // generateMessageId id and the messageMetadata token usage.
          const persisted = [...messages, responseMessage];
          await saveChatSession({ sessionId, messages: persisted });

          // Title only the first completed assistant reply, and only while the
          // session is still untitled. The sessionNeedsTitle precheck skips the
          // paid, stream-blocking title-model call on regenerate (where
          // assistantCount is still 1 but a title already exists);
          // setSessionTitleIfUnset remains the atomic write-time guard.
          const assistantCount = persisted.filter((message) => message.role === "assistant").length;

          if (assistantCount === 1 && (await sessionNeedsTitle(sessionId))) {
            const title = await generateSessionTitle({
              firstUserText: messageText(persisted.find((message) => message.role === "user")),
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
