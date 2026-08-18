import { memoryDocumentErrorResponse } from "@/app/api/memory-document/_errors";
import {
  deleteMemoryDocumentEntry,
  MemoryDocumentServiceInputError,
  updateMemoryDocumentEntry,
} from "@/lib/memory-document/service";

const PATCH_KEYS = new Set(["expectedVersion", "summary", "details"]);

type MemoryEntryRouteContext = { params: Promise<{ key: string }> };

export async function PATCH(req: Request, context: MemoryEntryRouteContext) {
  const { key } = await context.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    assertPatchBody(body);
    return Response.json(
      await updateMemoryDocumentEntry(key, {
        expectedVersion: body.expectedVersion,
        summary: body.summary,
        details: body.details,
      }),
    );
  } catch (error) {
    return memoryDocumentErrorResponse(error);
  }
}

export async function DELETE(req: Request, context: MemoryEntryRouteContext) {
  const { key } = await context.params;
  const raw = new URL(req.url).searchParams.get("expectedVersion");
  const expectedVersion = raw !== null && /^\d+$/u.test(raw) ? Number(raw) : raw;
  try {
    return Response.json(await deleteMemoryDocumentEntry(key, expectedVersion));
  } catch (error) {
    return memoryDocumentErrorResponse(error);
  }
}

function assertPatchBody(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryDocumentServiceInputError("Request body must be a JSON object.");
  }
  const unknownKey = Object.keys(value).find((key) => !PATCH_KEYS.has(key));
  if (unknownKey) {
    throw new MemoryDocumentServiceInputError(`Unsupported memory field: ${unknownKey}.`);
  }
  for (const key of PATCH_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new MemoryDocumentServiceInputError(`${key} is required.`);
    }
  }
}
