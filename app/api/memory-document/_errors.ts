import {
  MemoryDocumentEntryNotFoundError,
  MemoryDocumentServiceConflictError,
  MemoryDocumentServiceInputError,
} from "@/lib/memory-document/service";

export function memoryDocumentErrorResponse(error: unknown): Response {
  if (error instanceof MemoryDocumentServiceInputError) {
    return Response.json(
      { error: error.message, ...(error.issues.length ? { issues: error.issues } : {}) },
      { status: 400 },
    );
  }
  if (error instanceof MemoryDocumentServiceConflictError) {
    return Response.json(
      { error: error.message, conflict: true, currentVersion: error.currentVersion },
      { status: 409 },
    );
  }
  if (error instanceof MemoryDocumentEntryNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  console.error("Memory document request failed", error);
  return Response.json(
    { error: "Memory document request could not be completed." },
    { status: 500 },
  );
}
