import { listRecentRuns } from "@/lib/consolidation/explain";

/** GET /api/consolidation/runs — the "dream diary" run feed. */
export async function GET() {
  try {
    const runs = await listRecentRuns();
    return Response.json({ runs });
  } catch (error) {
    console.error("Listing consolidation runs failed", error);
    return Response.json({ error: "Consolidation runs unavailable." }, { status: 500 });
  }
}
