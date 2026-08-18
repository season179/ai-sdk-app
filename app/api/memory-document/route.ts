import { memoryDocumentErrorResponse } from "@/app/api/memory-document/_errors";
import { getMemoryDocumentControlPlane } from "@/lib/memory-document/service";

export async function GET() {
  try {
    return Response.json({ document: await getMemoryDocumentControlPlane() });
  } catch (error) {
    return memoryDocumentErrorResponse(error);
  }
}
