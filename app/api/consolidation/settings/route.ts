import type { ConsolidationWeights } from "@/db/schema";
import { upsertConsolidationSettings } from "@/lib/consolidation/config";
import { SelfImprovementInputError } from "@/lib/self-improvement/errors";

/** PUT /api/consolidation/settings — edit weights + gates → per-agent settings row. */
export async function PUT(req: Request) {
  let body: {
    enabled?: unknown;
    autoApplyEnabled?: unknown;
    dryRun?: unknown;
    minScoreBps?: unknown;
    minRecallCount?: unknown;
    minUniqueQueries?: unknown;
    maxAgeDays?: unknown;
    weights?: ConsolidationWeights;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  try {
    const row = await upsertConsolidationSettings({
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      autoApplyEnabled:
        typeof body.autoApplyEnabled === "boolean" ? body.autoApplyEnabled : undefined,
      dryRun: typeof body.dryRun === "boolean" ? body.dryRun : undefined,
      minScoreBps: num(body.minScoreBps),
      minRecallCount: num(body.minRecallCount),
      minUniqueQueries: num(body.minUniqueQueries),
      maxAgeDays: num(body.maxAgeDays),
      weights: body.weights,
    });
    return Response.json({ settings: row });
  } catch (error) {
    if (error instanceof SelfImprovementInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("Updating consolidation settings failed", error);
    return Response.json({ error: "Could not update consolidation settings." }, { status: 500 });
  }
}
