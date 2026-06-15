import { ChatSessionInputError, ChatSessionNotFoundError } from "@/lib/chat/sessions";

export function chatSessionErrorResponse(error: unknown) {
  // NotFound extends InputError, so check it first to keep the 404/400 split.
  if (error instanceof ChatSessionNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }

  if (error instanceof ChatSessionInputError) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  console.error("Chat-session request failed", error);
  return Response.json(
    {
      error:
        "Chat sessions are unavailable. Check that Postgres is running and DATABASE_URL is set.",
    },
    { status: 500 },
  );
}
