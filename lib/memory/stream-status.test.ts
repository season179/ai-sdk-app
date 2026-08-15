import { describe, expect, it } from "vitest";

import { classifyChatStreamEnd, isSuccessfulFinishReason } from "@/lib/memory/stream-status";

describe("chat stream terminal classification", () => {
  it.each(["stop", "length", "content-filter", "tool-calls"])(
    "accepts explicit successful finish reason %s",
    (reason) => expect(isSuccessfulFinishReason(reason)).toBe(true),
  );

  it("keeps an error-chunk stream failed when SDK flush calls onEnd without a reason", () => {
    expect(
      classifyChatStreamEnd({ streamErrored: true, isAborted: false, finishReason: undefined }),
    ).toBe("failed");
  });

  it.each([undefined, null, "error", "other"])(
    "rejects missing, error, and ambiguous finish reason %s",
    (reason) => expect(isSuccessfulFinishReason(reason)).toBe(false),
  );
});
