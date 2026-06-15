import { listChatSessions } from "@/lib/chat/sessions";

import { chatSessionErrorResponse } from "./_errors";

/** GET /api/sessions — sidebar summaries, newest activity first. */
export async function GET() {
  try {
    const sessions = await listChatSessions();
    return Response.json({ sessions });
  } catch (error) {
    return chatSessionErrorResponse(error);
  }
}
