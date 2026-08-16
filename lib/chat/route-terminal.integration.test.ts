import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  responseOptions: null as null | {
    onEnd: (input: {
      responseMessage: {
        id: string;
        role: "assistant";
        parts: UIMessage["parts"];
      };
      isAborted: boolean;
      finishReason: string;
    }) => Promise<void>;
  },
  enqueueDirtyProfile: vi.fn(),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => ({ chat: () => ({}) }),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    ToolLoopAgent: class {},
    createAgentUIStreamResponse: (options: typeof mocks.responseOptions) => {
      mocks.responseOptions = options;
      return new Response("ok");
    },
    consumeStream: vi.fn(),
    createIdGenerator: () => () => "generated-id",
    smoothStream: () => undefined,
  };
});
vi.mock("@/lib/chat/notify", () => ({
  notifySessionAppended: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/chat/title-agent", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/mock-tools", () => ({ mockToolCount: 0, mockTools: {} }));
vi.mock("@/lib/models/openrouter", () => ({
  resolveChatModel: vi.fn().mockResolvedValue("test/model"),
}));
vi.mock("@/lib/profile/dirty", () => ({ enqueueDirtyProfile: mocks.enqueueDirtyProfile }));
vi.mock("@/lib/profile/explicit", () => ({
  parseExplicitProfileIntent: vi.fn().mockReturnValue(null),
  applyExplicitProfileIntent: vi.fn(),
}));
vi.mock("@/lib/profile/read", () => ({
  getCurrentProfileVersionForRun: vi.fn().mockResolvedValue(null),
  getProfileVersionForRun: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/scheduler/tool-specs", () => ({ createSchedulerTools: () => ({}) }));
vi.mock("@/lib/self-improvement/enqueue", () => ({
  recordCompletedTurnAndMaybeEnqueueReview: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/self-improvement/memory-tools", () => ({
  createConversationSearchTools: () => ({}),
  createMemoryTools: () => ({}),
}));
vi.mock("@/lib/skills/catalog", () => ({
  formatSkillCatalog: () => "",
  getSkillCatalog: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/skills/tool-specs", () => ({ skillTools: {} }));
vi.mock("@/lib/tool-search", () => ({
  buildToolSearchMetadata: () => undefined,
  createToolSearchTools: () => ({}),
  resolveToolExposureMode: () => "all",
}));

import { POST } from "@/app/api/chat/route";
import { getDb } from "@/db";
import { agentChatSessions, agentGroundedObservations, agentTraceEvents } from "@/db/schema";
import { closePool, getPool } from "@/lib/scheduler/db";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

// Recorded from the live OpenRouter turns in /tmp/e2e-A-parts.log and
// /tmp/e2e-C-assistant-parts.log. `preliminary: undefined` is present on the
// in-memory SDK part but is removed by the jsonb serialization round-trip.
const productionResponseParts = [
  { type: "step-start" },
  {
    id: "15DRgGaiTVmgolyo",
    text: "The user explicitly asked to remember that they prefer dark mode.",
    type: "reasoning",
    state: "done",
    providerMetadata: {
      openrouter: {
        reasoning_details: [
          {
            text: "The user explicitly asked to remember that they prefer dark mode.",
            type: "reasoning.text",
            index: 0,
            format: "unknown",
          },
        ],
      },
    },
  },
  {
    type: "tool-memory_write",
    input: { action: "remember", content: "I prefer dark mode" },
    state: "output-available",
    title: "Remember, forget, or correct memory",
    output: { success: true, durable: true, synthesis: "queued" },
    toolCallId: "call_00_lWMafudiImBxrcc1qghH8522",
    preliminary: undefined,
    callProviderMetadata: {
      openrouter: {
        reasoning_details: [
          {
            text: "The user explicitly asked to remember that they prefer dark mode.",
            type: "reasoning.text",
            index: 0,
            format: "unknown",
          },
        ],
      },
    },
  },
  { type: "step-start" },
  {
    type: "text",
    text: "Done! I've saved that you prefer dark mode.",
    state: "done",
    providerMetadata: undefined,
  },
] as unknown as UIMessage["parts"];

integration("chat route terminal profile durability", () => {
  const previousEnv = {
    memoryWrite: process.env.AGENT_MEMORY_WRITE_ENABLED,
    synthesis: process.env.AGENT_PROFILE_SYNTHESIS_ENABLED,
    profile: process.env.AGENT_PROFILE_ENABLED,
  };

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_DEFAULT_MODEL = "test/model";
    process.env.AGENT_MEMORY_WRITE_ENABLED = "true";
    process.env.AGENT_PROFILE_SYNTHESIS_ENABLED = "true";
    process.env.AGENT_PROFILE_ENABLED = "false";
    process.env.AGENT_PROFILE_EXPLICIT_WRITE_ENABLED = "false";
    process.env.SELF_IMPROVEMENT_ENABLED = "false";
    process.env.MEMORY_SEARCH_ENABLED = "false";
    mocks.responseOptions = null;
    mocks.enqueueDirtyProfile.mockReset().mockRejectedValue(new Error("queue unavailable"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (previousEnv.memoryWrite === undefined) delete process.env.AGENT_MEMORY_WRITE_ENABLED;
    else process.env.AGENT_MEMORY_WRITE_ENABLED = previousEnv.memoryWrite;
    if (previousEnv.synthesis === undefined) delete process.env.AGENT_PROFILE_SYNTHESIS_ENABLED;
    else process.env.AGENT_PROFILE_SYNTHESIS_ENABLED = previousEnv.synthesis;
    if (previousEnv.profile === undefined) delete process.env.AGENT_PROFILE_ENABLED;
    else process.env.AGENT_PROFILE_ENABLED = previousEnv.profile;
    await closePool();
  });

  it("commits terminal insertion and generation/dirty state before a failed post-commit enqueue", async () => {
    const sessionId = randomUUID();
    const messageId = `user-${randomUUID()}`;
    const before = await getPool().query<{ dirty_generation: number }>(
      "select dirty_generation from agent_profiles where agent_id=$1",
      [DEFAULT_AGENT_ID],
    );
    const dirtyBefore = before.rows[0]?.dirty_generation ?? 0;
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: sessionId,
        trigger: "submit-message",
        message: {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text: "I prefer terminal-state durability." }],
        },
      }),
    });

    try {
      await expect(POST(request)).resolves.toMatchObject({ status: 200 });
      expect(mocks.responseOptions).not.toBeNull();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await mocks.responseOptions?.onEnd({
        responseMessage: {
          id: `assistant-${randomUUID()}`,
          role: "assistant",
          parts: productionResponseParts,
        },
        isAborted: false,
        finishReason: "stop",
      });
      expect(mocks.enqueueDirtyProfile).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "Enqueuing profile synthesis failed",
        expect.any(Error),
      );

      const terminal = await getPool().query<{ terminal_status: string }>(
        `select terminal_status from agent_trace_events
         where session_id=$1 and event_type='task_terminal_state'`,
        [sessionId],
      );
      const observation = await getPool().query<{ profile_generation: number | null }>(
        "select profile_generation from agent_grounded_observations where session_id=$1",
        [sessionId],
      );
      const root = await getPool().query<{
        dirty_generation: number;
        synthesized_generation: number;
      }>("select dirty_generation, synthesized_generation from agent_profiles where agent_id=$1", [
        DEFAULT_AGENT_ID,
      ]);
      expect(terminal.rows).toEqual([{ terminal_status: "completed" }]);
      expect(observation.rows).toHaveLength(1);
      expect(observation.rows[0].profile_generation).toBeTypeOf("number");
      expect(root.rows[0].dirty_generation).toBeGreaterThan(dirtyBefore);
      expect(root.rows[0].dirty_generation).toBeGreaterThanOrEqual(
        observation.rows[0].profile_generation ?? Number.MAX_SAFE_INTEGER,
      );
      expect(root.rows[0].dirty_generation).toBeGreaterThan(root.rows[0].synthesized_generation);
    } finally {
      const db = getDb();
      await db
        .delete(agentGroundedObservations)
        .where(eq(agentGroundedObservations.sessionId, sessionId));
      await db.delete(agentTraceEvents).where(eq(agentTraceEvents.sessionId, sessionId));
      await db.delete(agentChatSessions).where(eq(agentChatSessions.id, sessionId));
    }
  });
});
