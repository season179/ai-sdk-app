import {
  MemoryNotFoundError,
  SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE,
  SelfImprovementInputError,
} from "@/lib/self-improvement/errors";

export function memoryErrorResponse(error: unknown) {
  if (error instanceof MemoryNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }

  if (error instanceof SelfImprovementInputError) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  console.error("Memory request failed", error);
  return Response.json({ error: SELF_IMPROVEMENT_UNAVAILABLE_MESSAGE }, { status: 500 });
}
