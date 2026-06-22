import { listCandidatesForRun } from "@/lib/consolidation/explain";

/** GET /api/consolidation/candidates?runId=... — the candidate table for a run. */
export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId");

  if (!runId) {
    return Response.json({ error: "runId query parameter is required." }, { status: 400 });
  }

  try {
    const candidates = await listCandidatesForRun(runId);
    return Response.json({ candidates });
  } catch (error) {
    console.error("Listing consolidation candidates failed", error);
    return Response.json({ error: "Consolidation candidates unavailable." }, { status: 500 });
  }
}
