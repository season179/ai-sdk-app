import { memoryErrorResponse } from "@/app/api/memories/_errors";
import { createMemory, listMemories } from "@/lib/self-improvement/memories";

export async function GET() {
  try {
    const memories = await listMemories();
    return Response.json({ memories });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}

export async function POST(req: Request) {
  let body: {
    kind?: unknown;
    content?: unknown;
    source?: unknown;
    confidence?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    // §3a: the manual route always writes source='user' and ignores any client-
    // supplied source. Internal proposal apply is the only path allowed to set
    // non-user sources. The client cannot set source.
    const memory = await createMemory({
      kind: body.kind,
      content: body.content,
      source: "user",
      confidence: body.confidence,
    });

    return Response.json({ memory }, { status: 201 });
  } catch (error) {
    return memoryErrorResponse(error);
  }
}
