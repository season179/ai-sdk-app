import {
  getConsolidationConfig,
  isMemoryConsolidationAutoApply,
  isMemoryConsolidationDryRun,
  isMemoryConsolidationEnabled,
} from "@/lib/consolidation/config";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

/** GET /api/consolidation/status — the operator dashboard read. */
export async function GET() {
  try {
    const envEnabled = isMemoryConsolidationEnabled();
    const envAutoApply = isMemoryConsolidationAutoApply();
    const envDryRun = isMemoryConsolidationDryRun();

    const cfg = await getConsolidationConfig(DEFAULT_AGENT_ID);

    return Response.json({
      env: {
        enabled: envEnabled,
        dryRun: envDryRun,
        autoApply: envAutoApply,
      },
      settings: {
        enabled: cfg.enabled,
        autoApplyEnabled: cfg.autoApplyEnabled,
        dryRun: cfg.dryRun,
        minScoreBps: cfg.minScoreBps,
        minRecallCount: cfg.minRecallCount,
        minUniqueQueries: cfg.minUniqueQueries,
        maxAgeDays: cfg.maxAgeDays,
        weights: cfg.weights,
      },
    });
  } catch (error) {
    console.error("Consolidation status failed", error);
    return Response.json({ error: "Consolidation status unavailable." }, { status: 500 });
  }
}
