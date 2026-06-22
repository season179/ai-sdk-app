import { describe, expect, it } from "vitest";
import type { ChatUIMessage } from "@/lib/chat/sessions";
import { extractUserText } from "@/lib/consolidation/observations";

/**
 * Firewall negatives (§6, §4.1) — "the most important test."
 *
 * Feeding assistant text, a source='review' memory, or a source='consolidated'
 * memory through ingestion produces ZERO agent_grounded_observations and zero
 * evidence rows. A memory_search call produces zero observations.
 *
 * The role gate lives in extractUserText (the pure core of ingestUserTurn), so
 * we test it directly: only role==='user' + text parts survive. Assistant,
 * system, tool, and non-text parts are dropped.
 */
function userMsg(id: string, text: string): ChatUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}
function assistantMsg(id: string, text: string): ChatUIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}
function systemMsg(id: string, text: string): ChatUIMessage {
  return { id, role: "system", parts: [{ type: "text", text }] };
}
function userWithToolPart(id: string, text: string): ChatUIMessage {
  // A user turn that also carries a tool / non-text part — only the text part
  // should be ingested.
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text },
      { type: "tool-result", toolCallId: "tc_1", state: "output-available", input: {} },
    ],
  } as unknown as ChatUIMessage;
}

describe("firewall: role gate drops derivative content", () => {
  it("ingests only user text parts", () => {
    const out = extractUserText([
      userMsg("u1", "I prefer dark mode."),
      assistantMsg("a1", "You prefer dark mode."), // derivative — must drop
      systemMsg("s1", "Be helpful."), // derivative — must drop
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].messageId).toBe("u1");
    expect(out[0].text).toBe("I prefer dark mode.");
  });

  it("produces ZERO observations for an assistant-only batch", () => {
    const out = extractUserText([
      assistantMsg("a1", "Here is a summary."),
      assistantMsg("a2", "Another summary."),
    ]);
    expect(out).toHaveLength(0);
  });

  it("produces ZERO observations for a system-only batch", () => {
    const out = extractUserText([systemMsg("s1", "System instruction.")]);
    expect(out).toHaveLength(0);
  });

  it("drops non-text parts from a user turn but keeps the text", () => {
    const out = extractUserText([userWithToolPart("u1", "Run the deploy.")]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Run the deploy.");
  });

  it("drops empty user text", () => {
    const out = extractUserText([userMsg("u1", "   ")]);
    expect(out).toHaveLength(0);
  });

  it("does not dedupe repeated user statements (each counts as evidence)", () => {
    // §1.2: dedupe is by source identity, NEVER by content. Two user turns
    // with identical text both survive the role gate.
    const out = extractUserText([userMsg("u1", "I like Python."), userMsg("u2", "I like Python.")]);
    expect(out).toHaveLength(2);
  });
});

describe("firewall: memory_search produces zero observations", () => {
  // §10.4: memory_search is read-only and writes nothing. The assistant turn
  // that quotes a retrieved memory is derivative content that can never become
  // a grounded observation. This is asserted by the role gate above (assistant
  // turns are dropped) — a memory_search result restated by the assistant has
  // role==='assistant' and so never enters extractUserText.
  it("an assistant turn quoting a retrieved memory is dropped", () => {
    const out = extractUserText([
      assistantMsg("a1", "Based on your preferences: you prefer dark mode."),
    ]);
    expect(out).toHaveLength(0);
  });
});
