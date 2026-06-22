import { listRecentEvents } from "@/lib/consolidation/explain";

/** GET /api/memory-events — the timeline / "see the evolution" feed (§9.1). */
export async function GET() {
  try {
    const events = await listRecentEvents();
    return Response.json({ events });
  } catch (error) {
    console.error("Listing memory events failed", error);
    return Response.json({ error: "Memory events unavailable." }, { status: 500 });
  }
}
