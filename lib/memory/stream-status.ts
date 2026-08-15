const SUCCESSFUL_FINISH_REASONS = new Set(["stop", "length", "content-filter", "tool-calls"]);

/** Only explicit, provider-independent terminal reasons count as a successful stream. */
export function isSuccessfulFinishReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && SUCCESSFUL_FINISH_REASONS.has(reason);
}

export function classifyChatStreamEnd(input: {
  streamErrored: boolean;
  isAborted: boolean;
  finishReason: string | null | undefined;
}): "completed" | "failed" | "interrupted" {
  if (input.isAborted) return "interrupted";
  return !input.streamErrored && isSuccessfulFinishReason(input.finishReason)
    ? "completed"
    : "failed";
}
