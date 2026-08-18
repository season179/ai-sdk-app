import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  responseOptions: null as null | {
    onEnd: (input: {
      responseMessage: { id: string; role: "assistant"; parts: UIMessage["parts"] };
      isAborted: boolean;
      finishReason: string;
    }) => Promise<void>;
  },
  responseHeaders: null as Record<string, string> | null,
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => ({ chat: () => ({}) }),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    ToolLoopAgent: class {},
    createAgentUIStreamResponse: (
      options: typeof mocks.responseOptions & { headers?: Record<string, string> },
    ) => {
      mocks.responseOptions = options;
      mocks.responseHeaders = options.headers ?? null;
      return new Response("ok", { headers: options.headers });
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
vi.mock("@/lib/mock-tools", () => ({ mockTools: {} }));
vi.mock("@/lib/models/openrouter", () => ({
  resolveChatModel: vi.fn().mockResolvedValue("test/model"),
}));
vi.mock("@/lib/scheduler/tool-specs", () => ({ createSchedulerTools: () => ({}) }));
vi.mock("@/lib/self-improvement/enqueue", () => ({
  recordCompletedTurnAndMaybeEnqueueReview: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/self-improvement/memory-tools", () => ({ createMemoryTools: () => ({}) }));
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

import { maxDuration, POST } from "@/app/api/chat/route";
import { getDb } from "@/db";
import { agentChatSessions, agentGroundedObservations, agentTraceEvents } from "@/db/schema";
import { closePool, getPool } from "@/lib/scheduler/db";

const available =
  Boolean(process.env.DATABASE_URL) && process.env.CONSOLIDATION_INTEGRATION === "1";
const integration = available ? describe : describe.skip;

integration("chat route terminal memory behavior", () => {
  const previousWriteEnabled = process.env.AGENT_MEMORY_WRITE_ENABLED;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_DEFAULT_MODEL = "test/model";
    process.env.AGENT_MEMORY_WRITE_ENABLED = "true";
    process.env.SELF_IMPROVEMENT_ENABLED = "false";
    process.env.MEMORY_SEARCH_ENABLED = "false";
    mocks.responseOptions = null;
    mocks.responseHeaders = null;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (previousWriteEnabled === undefined) delete process.env.AGENT_MEMORY_WRITE_ENABLED;
    else process.env.AGENT_MEMORY_WRITE_ENABLED = previousWriteEnabled;
    await closePool();
  });

  it("uses the 60-second route and persists terminal state without profile work", async () => {
    getPool();
    const sessionId = randomUUID();
    const messageId = `user-${randomUUID()}`;
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: sessionId,
        trigger: "submit-message",
        message: {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text: "Keep terminal persistence." }],
        },
      }),
    });

    try {
      expect(maxDuration).toBe(60);
      await expect(POST(request)).resolves.toMatchObject({ status: 200 });
      // The shared default agent may already hold a real memory document, so
      // assert the header contract rather than a particular document state.
      expect(mocks.responseHeaders?.["x-memory-index-status"]).toMatch(/^(hit|empty)$/);
      expect(mocks.responseHeaders?.["x-memory-version"]).toMatch(/^\d+$/);
      expect(
        Object.keys(mocks.responseHeaders ?? {}).some((key) => key.startsWith("x-profile")),
      ).toBe(false);

      await mocks.responseOptions?.onEnd({
        responseMessage: {
          id: `assistant-${randomUUID()}`,
          role: "assistant",
          parts: [{ type: "text", text: "Persisted." }],
        },
        isAborted: false,
        finishReason: "stop",
      });

      const terminal = await getPool().query<{ terminal_status: string }>(
        `select terminal_status from agent_trace_events
         where session_id=$1 and event_type='task_terminal_state'`,
        [sessionId],
      );
      const observation = await getPool().query<{ profile_generation: number | null }>(
        "select profile_generation from agent_grounded_observations where session_id=$1",
        [sessionId],
      );
      expect(terminal.rows).toEqual([{ terminal_status: "completed" }]);
      expect(observation.rows).toHaveLength(1);
      expect(observation.rows[0].profile_generation).toBeNull();
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
