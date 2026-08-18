import { memoryDocumentErrorResponse } from "@/app/api/memory-document/_errors";
import {
  createMemoryDocumentEntry,
  MemoryDocumentServiceInputError,
} from "@/lib/memory-document/service";

const POST_KEYS = new Set(["expectedVersion", "summary", "details"]);

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    assertMutationBody(body);
    const result = await createMemoryDocumentEntry({
      expectedVersion: body.expectedVersion,
      summary: body.summary,
      details: body.details,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return memoryDocumentErrorResponse(error);
  }
}

function assertMutationBody(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryDocumentServiceInputError("Request body must be a JSON object.");
  }
  const unknownKey = Object.keys(value).find((key) => !POST_KEYS.has(key));
  if (unknownKey) {
    throw new MemoryDocumentServiceInputError(`Unsupported memory field: ${unknownKey}.`);
  }
  for (const key of POST_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new MemoryDocumentServiceInputError(`${key} is required.`);
    }
  }
}
