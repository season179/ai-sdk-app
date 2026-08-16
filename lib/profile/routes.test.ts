import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETE } from "@/app/api/profile/facts/[factKey]/route";
import { GET, PUT } from "@/app/api/profile/route";
import { POST } from "@/app/api/profile/synthesize/route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("profile routes", () => {
  it("rejects malformed JSON and non-object PUT bodies", async () => {
    const malformed = await PUT(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);

    const array = await PUT(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "[]",
      }),
    );
    expect(array.status).toBe(400);
  });

  it("does not accept client authority or source override fields", async () => {
    const response = await PUT(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "The user likes tea.",
          expectedVersionId: null,
          authority: "synthesized",
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/authority/),
    });
  });

  it("rejects malformed optimistic version IDs without touching persistence", async () => {
    vi.stubEnv("AGENT_PROFILE_EXPLICIT_WRITE_ENABLED", "true");
    const save = await PUT(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "The user likes tea.", expectedVersionId: "not-a-uuid" }),
      }),
    );
    expect(save.status).toBe(400);

    const remove = await DELETE(
      new Request("http://localhost/api/profile/facts/fact-one?expectedVersionId=nope", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ factKey: "fact-one" }) },
    );
    expect(remove.status).toBe(400);
  });

  it("gates reads and all mutations with independent flags", async () => {
    vi.stubEnv("AGENT_PROFILE_ENABLED", "false");
    vi.stubEnv("AGENT_PROFILE_SYNTHESIS_ENABLED", "false");
    vi.stubEnv("AGENT_PROFILE_EXPLICIT_WRITE_ENABLED", "false");

    expect((await GET()).status).toBe(409);
    expect(
      (
        await PUT(
          new Request("http://localhost/api/profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: "The user likes tea.", expectedVersionId: null }),
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await DELETE(new Request("http://localhost/api/profile/facts/fact-one"), {
          params: Promise.resolve({ factKey: "fact-one" }),
        })
      ).status,
    ).toBe(409);

    vi.stubEnv("AGENT_PROFILE_EXPLICIT_WRITE_ENABLED", "true");
    expect((await POST()).status).toBe(409);
  });
});
