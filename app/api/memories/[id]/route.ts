import { memoryErrorResponse } from "@/app/api/memories/_errors";
import { archiveMemory, setMemoryProtection, updateMemory } from "@/lib/self-improvement/memories";
import { isUuid } from "@/lib/utils";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function invalidIdResponse(id: string) {
  return Response.json({ error: `No memory with id '${id}' was found.` }, { status: 404 });
}

export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!isUuid(id)) {
    return invalidIdResponse(id);
  }

  let body: {
    kind?: unknown;
    content?: unknown;
    source?: unknown;
    confidence?: unknown;
    status?: "approved" | "archived";
    isProtected?: boolean;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    // A protection toggle is its own path (§9.3): setMemoryProtection persists
    // is_protected/protected_at/protected_by and fires the protected/unprotected
    // event. updateMemory never writes protection, so isProtected must be
    // dispatched here rather than passed through (otherwise the pin is a silent
    // no-op that also logs a misleading "edited" event).
    const memory =
      typeof body.isProtected === "boolean"
        ? await setMemoryProtection(id, body.isProtected)
        : await updateMemory(id, body);
    return Response.json({ memory });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function DELETE(_req: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!isUuid(id)) {
    return invalidIdResponse(id);
  }

  try {
    const memory = await archiveMemory(id);
    return Response.json({ memory });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}
