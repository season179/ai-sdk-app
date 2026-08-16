import { describe, expect, it } from "vitest";

import {
  CONVERSATION_SEARCH_EXCERPT_MAX_CHARS,
  CONVERSATION_SEARCH_MAX_LIMIT,
  CONVERSATION_SEARCH_TOTAL_OUTPUT_MAX_CHARS,
  type ConversationSearchStorageRow,
  compareConversationTuples,
  decodeConversationCursor,
  encodeConversationCursor,
  parseConversationSearchInput,
  parseIsoInstant,
  searchConversationsByTime,
} from "@/lib/chat/conversation-search";

const SESSION_A = "00000000-0000-4000-8000-000000000001";
const SESSION_B = "00000000-0000-4000-8000-000000000002";

describe("conversation temporal input", () => {
  it("strictly parses complete ISO instants and normalizes timezone offsets for comparison", () => {
    expect(parseIsoInstant("2026-02-03T04:05:06.123456Z").epochNanoseconds).toBe(
      parseIsoInstant("2026-02-03T12:05:06.123456+08:00").epochNanoseconds,
    );

    for (const invalid of [
      "2026-02-03",
      "2026-02-03T04:05:06",
      "2026-02-30T04:05:06Z",
      "2026-02-03T24:00:00Z",
      "2026-02-03T04:05:60Z",
      "2026-02-03T04:05:06+14:01",
      " 2026-02-03T04:05:06Z",
    ]) {
      expect(() => parseIsoInstant(invalid)).toThrow(/ISO-8601|valid/);
    }
  });

  it("enforces from-inclusive/to-exclusive cursor boundaries and a 90-day cap", () => {
    const atFrom = encodeConversationCursor({
      createdAt: "2026-01-01T00:00:00.000000Z",
      sessionId: SESSION_A,
      messageId: "at-from",
    });
    expect(
      parseConversationSearchInput({
        from: "2026-01-01T00:00:00Z",
        to: "2026-04-01T00:00:00Z",
        cursor: atFrom,
      }).cursor?.messageId,
    ).toBe("at-from");

    const atTo = encodeConversationCursor({
      createdAt: "2026-04-01T00:00:00Z",
      sessionId: SESSION_A,
      messageId: "at-to",
    });
    expect(() =>
      parseConversationSearchInput({
        from: "2026-01-01T00:00:00Z",
        to: "2026-04-01T00:00:00Z",
        cursor: atTo,
      }),
    ).toThrow(/outside/);

    expect(() =>
      parseConversationSearchInput({
        from: "2026-01-01T00:00:00Z",
        to: "2026-04-01T00:00:00.000000001Z",
      }),
    ).toThrow(/90 days/);
    expect(() =>
      parseConversationSearchInput({
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/earlier/);
  });

  it("rejects malformed or tampered cursor fields", () => {
    const valid = encodeConversationCursor({
      createdAt: "2026-01-01T00:00:00.123456Z",
      sessionId: SESSION_A,
      messageId: "message-1",
    });
    expect(decodeConversationCursor(valid)).toEqual({
      createdAt: "2026-01-01T00:00:00.123456Z",
      sessionId: SESSION_A,
      messageId: "message-1",
    });

    const cursors = [
      "not+base64",
      Buffer.from(JSON.stringify(["2026-01-01T00:00:00Z", SESSION_A])).toString("base64url"),
      Buffer.from(JSON.stringify(["not-a-time", SESSION_A, "m"])).toString("base64url"),
      Buffer.from(JSON.stringify(["2026-01-01T00:00:00Z", "other-agent", "m"])).toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify(["2026-01-01T00:00:00Z", SESSION_A, ""])).toString("base64url"),
    ];
    for (const cursor of cursors) expect(() => decodeConversationCursor(cursor)).toThrow(/cursor/);
  });

  it("orders timestamp ties by session and message id in both directions", () => {
    const timestamp = "2026-01-01T00:00:00.000000Z";
    const tuples = [
      { createdAt: timestamp, sessionId: SESSION_B, messageId: "a" },
      { createdAt: timestamp, sessionId: SESSION_A, messageId: "b" },
      { createdAt: timestamp, sessionId: SESSION_A, messageId: "a" },
    ];
    expect([...tuples].sort((a, b) => compareConversationTuples(a, b, "asc"))).toEqual([
      tuples[2],
      tuples[1],
      tuples[0],
    ]);
    expect([...tuples].sort((a, b) => compareConversationTuples(a, b, "desc"))).toEqual([
      tuples[0],
      tuples[1],
      tuples[2],
    ]);
  });
});

describe("conversation temporal result bounds", () => {
  it("caps result count, each excerpt, and aggregate excerpt output", async () => {
    const rows: ConversationSearchStorageRow[] = Array.from(
      { length: CONVERSATION_SEARCH_MAX_LIMIT + 1 },
      (_, index) => ({
        sessionId: SESSION_A,
        title: "A chat",
        messageId: `message-${String(index).padStart(2, "0")}`,
        role: "user",
        parts: [{ type: "text", text: "x".repeat(700) }],
        createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000000Z`,
      }),
    );

    const response = await searchConversationsByTime(
      {
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
        order: "asc",
        limit: CONVERSATION_SEARCH_MAX_LIMIT,
      },
      { agentId: SESSION_B, query: async () => rows },
    );

    expect(response.results.length).toBeLessThanOrEqual(CONVERSATION_SEARCH_MAX_LIMIT);
    expect(response.results.length).toBeGreaterThan(0);
    expect(
      response.results.every(
        (result) => Array.from(result.excerpt).length <= CONVERSATION_SEARCH_EXCERPT_MAX_CHARS,
      ),
    ).toBe(true);
    expect(Array.from(JSON.stringify(response)).length).toBeLessThanOrEqual(
      CONVERSATION_SEARCH_TOTAL_OUTPUT_MAX_CHARS,
    );
    expect(response.nextCursor).toBeTruthy();
  });

  it("extracts only visible clean text parts and redacts projection fences", async () => {
    const response = await searchConversationsByTime(
      {
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      },
      {
        agentId: SESSION_A,
        query: async () => [
          {
            sessionId: SESSION_A,
            title: null,
            messageId: "safe",
            role: "user",
            parts: [
              { type: "text", text: "visible" },
              { type: "tool-result", output: "hidden" },
              { type: "text", text: "<memory_context>injected</memory_context>after" },
            ],
            createdAt: "2026-01-01T00:00:00.000000Z",
          },
        ],
      },
    );
    expect(response.results[0].excerpt).toBe("visible\n[read projection redacted]after");
    expect(response.results[0].excerpt).not.toContain("hidden");
  });

  it("redacts secrets before returning model-visible excerpts", async () => {
    const response = await searchConversationsByTime(
      {
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      },
      {
        agentId: SESSION_A,
        query: async () => [
          {
            sessionId: SESSION_A,
            title: null,
            messageId: "secret",
            role: "user",
            parts: [{ type: "text", text: "remember that my password is hunter2" }],
            createdAt: "2026-01-01T00:00:00.000000Z",
          },
        ],
      },
    );
    expect(response.results[0].excerpt).toBe("remember that [REDACTED_SECRET]");
    expect(response.results[0].excerpt).not.toContain("hunter2");
  });
});
