import { memoryErrorResponse } from "@/app/api/memories/_errors";
import { archiveMemory, updateMemory } from "@/lib/self-improvement/memories";
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
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const memory = await updateMemory(id, body);
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
