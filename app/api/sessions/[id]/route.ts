import { deleteChatSession, getChatSession, renameChatSession } from "@/lib/chat/sessions";

import { chatSessionErrorResponse } from "../_errors";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** GET /api/sessions/:id — session + ordered messages for loading into useChat. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const session = await getChatSession(id);

    if (!session) {
      return Response.json(
        { error: `No chat session with id '${id}' was found.` },
        { status: 404 },
      );
    }

    return Response.json(session);
  } catch (error) {
    return chatSessionErrorResponse(error);
  }
}

/** PATCH /api/sessions/:id — rename. Body: { title }. */
export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;

  let body: { title?: unknown };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.title !== "string") {
    return Response.json({ error: "A title string is required." }, { status: 400 });
  }

  try {
    const session = await renameChatSession(id, body.title);
    return Response.json({ session });
  } catch (error) {
    return chatSessionErrorResponse(error);
  }
}

/** DELETE /api/sessions/:id — soft delete. */
export async function DELETE(_req: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    await deleteChatSession(id);
    return Response.json({ ok: true });
  } catch (error) {
    return chatSessionErrorResponse(error);
  }
}
