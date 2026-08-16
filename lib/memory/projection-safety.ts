import type { AgentTraceEvent } from "@/db/schema";

const PROJECTION_FENCES = [
  {
    name: "current_turn_metadata",
    opening: /<current_turn_metadata>/g,
    closing: "</current_turn_metadata>",
  },
  { name: "memory_context", opening: /<memory_context>/g, closing: "</memory_context>" },
  { name: "available_skills", opening: /<available_skills>/g, closing: "</available_skills>" },
  { name: "skill_content", opening: /<skill_content(?:\s[^>]*)?>/g, closing: "</skill_content>" },
  {
    name: "reference_content",
    opening: /<reference_content(?:\s[^>]*)?>/g,
    closing: "</reference_content>",
  },
] as const;

export const DERIVATIVE_RETRIEVAL_TOOLS = new Set([
  "memory_search",
  "conversation_time_search",
  "skill_search",
  "skill_get_content",
]);

export type ProjectionRedaction = {
  text: string;
  contaminated: boolean;
  markers: string[];
};

/** Removes exact read-owned projection fences, including an unterminated trailing fence. */
export function redactReadProjection(text: string): ProjectionRedaction {
  let redacted = text;
  const markers = new Set<string>();

  for (const fence of PROJECTION_FENCES) {
    fence.opening.lastIndex = 0;
    let match = fence.opening.exec(redacted);
    while (match) {
      const start = match.index;
      const bodyStart = start + match[0].length;
      const closeAt = redacted.indexOf(fence.closing, bodyStart);
      const end = closeAt < 0 ? redacted.length : closeAt + fence.closing.length;
      redacted = `${redacted.slice(0, start)}[read projection redacted]${redacted.slice(end)}`;
      markers.add(fence.name);
      fence.opening.lastIndex = start + "[read projection redacted]".length;
      match = fence.opening.exec(redacted);
    }
  }

  return {
    text: redacted.replace(/\n{3,}/g, "\n\n").trim(),
    contaminated: markers.size > 0,
    markers: [...markers],
  };
}

export function isDerivativeRetrievalEvent(event: Pick<AgentTraceEvent, "eventType" | "payload">) {
  if (event.eventType !== "tool_result") return false;
  if (event.payload.derivative === true) return true;
  return (
    typeof event.payload.toolName === "string" &&
    DERIVATIVE_RETRIEVAL_TOOLS.has(event.payload.toolName)
  );
}

export function isProjectionContaminatedEvent(event: Pick<AgentTraceEvent, "payload">) {
  return event.payload.projectionContaminated === true;
}

/** Reviewer/extractor boundary: retain journal rows, but never extract from read-derived content. */
export function isExtractionSafeTraceEvent(event: Pick<AgentTraceEvent, "eventType" | "payload">) {
  return !isDerivativeRetrievalEvent(event) && !isProjectionContaminatedEvent(event);
}
