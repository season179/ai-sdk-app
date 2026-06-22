import { isMemoryConsolidationEnabled } from "@/lib/consolidation/config";
import { enqueueConsolidation } from "@/lib/consolidation/jobs";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/** POST /api/consolidation/run — the "Run now" button. Enqueues a manual sweep. */
export async function POST() {
  if (!isMemoryConsolidationEnabled()) {
    return Response.json(
      { error: "Memory consolidation is disabled (MEMORY_CONSOLIDATION_ENABLED=false)." },
      { status: 409 },
    );
  }

  try {
    const jobId = await enqueueConsolidation(DEFAULT_AGENT_ID, { trigger: "manual" });
    if (!jobId) {
      // A sweep is already queued for this agent (singletonKey coalesced it).
      return Response.json({ enqueued: false, reason: "already-queued" });
    }
    return Response.json({ enqueued: true, jobId });
  } catch (error) {
    console.error("Enqueuing consolidation run failed", error);
    return Response.json({ error: "Could not enqueue consolidation run." }, { status: 500 });
  }
}
