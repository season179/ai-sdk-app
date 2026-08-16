import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendSessionMessages: vi.fn(),
  getChatSessionForRun: vi.fn(),
  materializeMessageRunProjection: vi.fn(),
  getCurrentProfileVersionForRun: vi.fn(),
  getProfileVersionForRun: vi.fn(),
  agentOptions: null as { instructions?: string } | null,
  responseOptions: null as { headers?: Record<string, string> } | null,
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
      mocks.responseOptions = options;
      return new Response("ok", { headers: options.headers });
    },
    consumeStream: vi.fn(),
    createIdGenerator: () => () => "generated-id",
    smoothStream: () => undefined,
  };
});

vi.mock("@/lib/chat/notify", () => ({ notifySessionAppended: vi.fn() }));
vi.mock("@/lib/chat/title-agent", () => ({ generateSessionTitle: vi.fn() }));
vi.mock("@/lib/chat/sessions", () => {
  class ChatBranchConflictError extends Error {}
  class ChatMessagePartsMismatchError extends ChatBranchConflictError {
    constructor(readonly winningParts: unknown[]) {
      super("mismatch");
    }
  }
  return {
    appendSessionMessages: mocks.appendSessionMessages,
    ChatBranchConflictError,
    ChatMessagePartsMismatchError,
    getChatSessionForRun: mocks.getChatSessionForRun,
    materializeMessageRunProjection: mocks.materializeMessageRunProjection,
    sessionNeedsTitle: vi.fn(),
    setSessionTitleIfUnset: vi.fn(),
    truncateConversationAfterMessage: vi.fn(),
  };
});
vi.mock("@/lib/mock-tools", () => ({ mockToolCount: 0, mockTools: {} }));
vi.mock("@/lib/models/openrouter", () => ({
  resolveChatModel: vi.fn().mockResolvedValue("test/model"),
}));
vi.mock("@/lib/profile/read", () => ({
  getCurrentProfileVersionForRun: mocks.getCurrentProfileVersionForRun,
  getProfileVersionForRun: mocks.getProfileVersionForRun,
}));
vi.mock("@/lib/scheduler/tool-specs", () => ({ createSchedulerTools: () => ({}) }));
vi.mock("@/lib/self-improvement/enqueue", () => ({
  recordCompletedTurnAndMaybeEnqueueReview: vi.fn(),
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
import { PROFILE_REFERENCE_POLICY } from "@/lib/profile/context";

const sessionId = "00000000-0000-4000-8000-000000000111";
const profileId = "00000000-0000-4000-8000-000000000222";
const message = {
  id: "user-trivial",
  role: "user" as const,
  parts: [{ type: "text" as const, text: "Hi!" }],
};
const profile = {
  id: profileId,
  agentId: "00000000-0000-0000-0000-000000000001",
  versionNo: 1,
  body: "The user prefers concise replies.",
  facts: [],
  authority: "synthesized" as const,
  trigger: "scheduled" as const,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  tokenCount: 7,
};
const winnerProfile = {
  ...profile,
  id: "00000000-0000-4000-8000-000000000333",
  versionNo: 2,
  body: "The winner profile is authoritative for this run.",
  tokenCount: 9,
};

function request() {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionId, trigger: "submit-message", message }),
  });
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_DEFAULT_MODEL = "test/model";
  process.env.AGENT_PROFILE_ENABLED = "true";
  process.env.SELF_IMPROVEMENT_ENABLED = "false";
  process.env.MEMORY_SEARCH_ENABLED = "false";
  mocks.agentOptions = null;
  mocks.responseOptions = null;
  mocks.appendSessionMessages.mockReset().mockResolvedValue({
    traceCaptured: false,
    persistedMessages: [message],
    insertedMessageIds: [message.id],
    branchRevision: 0,
  });
  mocks.getChatSessionForRun.mockReset().mockResolvedValue({
    session: {
      id: sessionId,
      title: null,
      lastMessageAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    cleanMessages: [message],
    modelMessages: [message],
    apiPartMessageIds: [],
    profileVersionIds: { [message.id]: null },
    branchRevision: 0,
  });
  mocks.materializeMessageRunProjection
    .mockReset()
    .mockImplementation(
      async (_sessionId, _messageId, _clean, projected, candidateProfileVersionId) => ({
        parts: projected,
        profileVersionId: candidateProfileVersionId,
      }),
    );
  mocks.getCurrentProfileVersionForRun.mockReset().mockResolvedValue(profile);
  mocks.getProfileVersionForRun.mockReset().mockResolvedValue(profile);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chat route profile projection", () => {
  it("loads and binds a profile on a brand-new trivial turn with recall disabled", async () => {
    const response = await POST(request());
    const instructions = mocks.agentOptions?.instructions ?? "";

    expect(mocks.appendSessionMessages).toHaveBeenCalledWith(
      sessionId,
      [message],
      expect.objectContaining({ createIfMissing: true }),
    );
    expect(mocks.getCurrentProfileVersionForRun).toHaveBeenCalledTimes(1);
    expect(mocks.materializeMessageRunProjection).toHaveBeenCalledWith(
      sessionId,
      message.id,
      message.parts,
      expect.any(Array),
      profileId,
      0,
    );
    expect(response.headers.get("x-profile-status")).toBe("hit");
    expect(response.headers.get("x-profile-chars")).toBe(String(profile.body.length));
    expect(response.headers.get("x-profile-tokens")).toBe("7");
    expect(instructions.indexOf(PROFILE_REFERENCE_POLICY)).toBeLessThan(
      instructions.indexOf('<user_profile trust="untrusted-read-projection"'),
    );
    expect(instructions.match(/<user_profile /g)).toHaveLength(1);
    expect(instructions).toContain("The user prefers concise replies.");
  });

  it("reloads and renders another writer's winning profile id", async () => {
    mocks.materializeMessageRunProjection.mockImplementation(
      async (_sessionId, _messageId, _clean, projected) => ({
        parts: projected,
        profileVersionId: winnerProfile.id,
      }),
    );
    mocks.getProfileVersionForRun.mockResolvedValue(winnerProfile);

    const response = await POST(request());
    const instructions = mocks.agentOptions?.instructions ?? "";

    expect(mocks.getProfileVersionForRun).toHaveBeenCalledWith(
      winnerProfile.id,
      profile.agentId,
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    expect(response.headers.get("x-profile-status")).toBe("hit");
    expect(instructions).toContain(winnerProfile.body);
    expect(instructions).not.toContain(profile.body);
  });

  it("degrades after the shared two-second deadline without injecting a block", async () => {
    vi.useFakeTimers();
    mocks.getCurrentProfileVersionForRun.mockImplementation(() => new Promise(() => {}));

    const pendingResponse = POST(request());
    await vi.advanceTimersByTimeAsync(2_001);
    const response = await pendingResponse;
    const instructions = mocks.agentOptions?.instructions ?? "";

    expect(response.headers.get("x-profile-status")).toBe("degraded");
    expect(instructions).toContain(PROFILE_REFERENCE_POLICY);
    expect(instructions).not.toContain("<user_profile trust=");
    expect(mocks.materializeMessageRunProjection).toHaveBeenCalledWith(
      sessionId,
      message.id,
      message.parts,
      expect.any(Array),
      null,
      0,
    );
  });
});
