import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentOptions: null as { instructions?: string } | null,
  responseHeaders: null as Record<string, string> | null,
  memoryToolContext: null as Record<string, unknown> | null,
  memoryIndex: {
    status: "hit" as "hit" | "empty" | "degraded",
    version: 12,
    block:
      '<memory_index trust="untrusted-user-memory-index" version="12">\n- [2026-01-01T00:00:00.000Z] [key=mem_00000000000000000000000000000001] The user likes tea.\n</memory_index>',
    indexBody: "index",
    degradedKeys: [],
  },
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => ({ chat: () => ({}) }),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    ToolLoopAgent: class {
      constructor(options: { instructions?: string }) {
        mocks.agentOptions = options;
      }
    },
    createAgentUIStreamResponse: (options: { headers?: Record<string, string> }) => {
      mocks.responseHeaders = options.headers ?? null;
      return new Response("ok", { headers: options.headers });
    },
    consumeStream: vi.fn(),
    createIdGenerator: () => () => "generated-id",
    smoothStream: () => undefined,
  };
});
vi.mock("@/lib/memory-document/context", () => ({
  loadMemoryIndexContext: vi.fn(async () => mocks.memoryIndex),
}));
vi.mock("@/lib/mock-tools", () => ({ mockTools: {} }));
vi.mock("@/lib/models/openrouter", () => ({
  resolveChatModel: vi.fn().mockResolvedValue("test/model"),
}));
vi.mock("@/lib/scheduler/tool-specs", () => ({ createSchedulerTools: () => ({}) }));
vi.mock("@/lib/self-improvement/memory-tools", () => ({
  createMemoryTools: (context: Record<string, unknown>) => {
    mocks.memoryToolContext = context;
    return {};
  },
}));
vi.mock("@/lib/skills/catalog", () => ({
  formatSkillCatalog: () => "",
  getSkillCatalog: vi.fn(async () => []),
}));
vi.mock("@/lib/skills/tool-specs", () => ({ skillTools: {} }));
vi.mock("@/lib/tool-search", () => ({
  buildToolSearchMetadata: () => undefined,
  createToolSearchTools: () => ({}),
  resolveToolExposureMode: () => "all",
}));

import { POST } from "@/app/api/chat/route";

function request() {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trigger: "submit-message",
      message: { id: "user-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    }),
  });
}

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_DEFAULT_MODEL", "test/model");
  vi.stubEnv("NODE_ENV", "development");
  mocks.agentOptions = null;
  mocks.responseHeaders = null;
  mocks.memoryToolContext = null;
});

afterEach(() => vi.unstubAllEnvs());

describe("chat memory index injection", () => {
  it("injects only Layer 1 and exposes only the two memory headers", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.agentOptions?.instructions).toContain("<memory_index");
    expect(mocks.agentOptions?.instructions).toContain("The user likes tea.");
    expect(mocks.agentOptions?.instructions).not.toContain("<user_profile");
    expect(mocks.responseHeaders).toEqual({
      "x-memory-index-status": "hit",
      "x-memory-version": "12",
    });
    expect(mocks.memoryToolContext).toMatchObject({
      agentId: "00000000-0000-0000-0000-000000000001",
      modelId: "test/model",
      apiKey: "test-key",
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("omits the version header in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await POST(request());
    expect(mocks.responseHeaders).toEqual({ "x-memory-index-status": "hit" });
  });
});
