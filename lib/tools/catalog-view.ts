import "server-only";

import { isMemorySearchEnabled } from "@/lib/consolidation/config";
import { mockToolSpecs, type RealisticToolSpec } from "@/lib/mock-tools";
import { isConversationSearchEnabled, isProfileExplicitWriteEnabled } from "@/lib/profile/config";
import { schedulerToolSpecs } from "@/lib/scheduler/tool-specs";
import { memoryToolSpecs } from "@/lib/self-improvement/memory-tools";
import { getSkillCatalog } from "@/lib/skills/catalog";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";
import { skillToolSpecs } from "@/lib/skills/tool-specs";
import { resolveToolExposureMode } from "@/lib/tool-search";
import { toolRegistry } from "@/lib/tools/registry";

export type CatalogToolBacking = "real" | "mocked";
export type SkillAvailability = "enabled" | "none" | "unknown";
export type ToolExposureMode = ReturnType<typeof resolveToolExposureMode>;

export type CatalogTool = RealisticToolSpec & {
  backing: CatalogToolBacking;
  direct: boolean;
  bridgeReachable: boolean;
  gate: "skill" | "memory" | null;
};

export type ToolCatalogSnapshot = {
  asOf: string;
  mode: ToolExposureMode;
  skillAvailability: SkillAvailability;
  memorySearchEnabled: boolean;
  profileExplicitWriteEnabled: boolean;
  conversationSearchEnabled: boolean;
  warning: string | null;
  bridgeToolCount: number;
  tools: CatalogTool[];
  counts: {
    total: number;
    real: number;
    mocked: number;
    direct: number;
    bridgeReachable: number;
    unavailable: number;
  };
};

export type CatalogClassification = {
  mockedNames: ReadonlySet<string>;
  realNames: ReadonlySet<string>;
  skillNames: ReadonlySet<string>;
  memoryNames: ReadonlySet<string>;
};

export type BuildToolCatalogSnapshotInput = {
  specs: readonly RealisticToolSpec[];
  classification: CatalogClassification;
  mode: ToolExposureMode;
  skillAvailability: SkillAvailability;
  memorySearchEnabled: boolean;
  profileExplicitWriteEnabled?: boolean;
  conversationSearchEnabled: boolean;
  asOf: string;
};

function specNames(specs: readonly RealisticToolSpec[]): ReadonlySet<string> {
  return new Set(specs.map((spec) => spec.name));
}

/** Exported name sets keep catalog classification explicit and testable. */
export const mockToolSpecNames = specNames(mockToolSpecs);
export const schedulerToolSpecNames = specNames(schedulerToolSpecs);
export const skillToolSpecNames = specNames(skillToolSpecs);
export const memoryToolSpecNames = specNames(memoryToolSpecs);
export const realToolSpecNames = new Set([
  ...schedulerToolSpecNames,
  ...skillToolSpecNames,
  ...memoryToolSpecNames,
]);

/** The central deferred registry plus the separately gated memory tool. */
export const catalogToolSpecs: readonly RealisticToolSpec[] = [
  ...toolRegistry.specs,
  ...memoryToolSpecs,
];

export const catalogClassification: CatalogClassification = {
  mockedNames: mockToolSpecNames,
  realNames: realToolSpecNames,
  skillNames: skillToolSpecNames,
  memoryNames: memoryToolSpecNames,
};

/**
 * Pure catalog builder. It validates the source wiring before assigning the
 * route-equivalent direct and bridge exposure bits to every tool.
 */
export function buildToolCatalogSnapshot({
  specs,
  classification,
  mode,
  skillAvailability,
  memorySearchEnabled,
  profileExplicitWriteEnabled = false,
  conversationSearchEnabled,
  asOf,
}: BuildToolCatalogSnapshotInput): ToolCatalogSnapshot {
  validateClassification(specs, classification);

  // Keep this policy aligned with the tools assembly in app/api/chat/route.ts:
  // search mode exposes the three bridge tools, while skills and memory are
  // independently added as direct tools by their own gates.
  const tools = specs.map<CatalogTool>((spec) => {
    const isMocked = classification.mockedNames.has(spec.name);
    const isSkill = classification.skillNames.has(spec.name);
    const isMemory = classification.memoryNames.has(spec.name);
    const isRegistryTool = !isMemory;

    return {
      ...spec,
      backing: isMocked ? "mocked" : "real",
      direct: isMemory
        ? spec.name === "conversation_time_search"
          ? conversationSearchEnabled
          : spec.name === "memory_write"
            ? profileExplicitWriteEnabled
            : memorySearchEnabled
        : isSkill
          ? skillAvailability === "enabled"
          : mode === "all",
      bridgeReachable: mode === "search" && isRegistryTool,
      gate: isSkill ? "skill" : isMemory ? "memory" : null,
    };
  });

  return {
    asOf,
    mode,
    skillAvailability,
    memorySearchEnabled,
    profileExplicitWriteEnabled,
    conversationSearchEnabled,
    warning:
      skillAvailability === "unknown"
        ? "Enabled skills could not be loaded. Direct access for skill tools is unknown; bridge access is shown normally."
        : null,
    bridgeToolCount: mode === "search" ? 3 : 0,
    tools,
    counts: {
      total: tools.length,
      real: tools.filter((tool) => tool.backing === "real").length,
      mocked: tools.filter((tool) => tool.backing === "mocked").length,
      direct: tools.filter((tool) => tool.direct).length,
      bridgeReachable: tools.filter((tool) => tool.bridgeReachable).length,
      unavailable: tools.filter((tool) => !tool.direct && !tool.bridgeReachable).length,
    },
  };
}

function validateClassification(
  specs: readonly RealisticToolSpec[],
  classification: CatalogClassification,
): void {
  const seen = new Set<string>();

  for (const spec of specs) {
    if (seen.has(spec.name)) {
      throw new Error(`Duplicate catalog tool name '${spec.name}'.`);
    }
    seen.add(spec.name);

    const isMocked = classification.mockedNames.has(spec.name);
    const isReal = classification.realNames.has(spec.name);

    if (isMocked === isReal) {
      throw new Error(
        isMocked
          ? `Catalog tool '${spec.name}' is classified as both real and mocked.`
          : `Catalog tool '${spec.name}' is unclassified.`,
      );
    }

    if (
      (classification.skillNames.has(spec.name) || classification.memoryNames.has(spec.name)) &&
      !isReal
    ) {
      throw new Error(`Gated catalog tool '${spec.name}' must be classified as real.`);
    }
  }

  for (const name of [...classification.mockedNames, ...classification.realNames]) {
    if (!seen.has(name)) {
      throw new Error(`Classification includes unknown catalog tool '${name}'.`);
    }
  }
}

/** Builds a page-load snapshot from the same env and skill catalog used by chat. */
export async function loadToolCatalogSnapshot(): Promise<ToolCatalogSnapshot> {
  let skillAvailability: SkillAvailability = "unknown";

  try {
    const skills = await getSkillCatalog(DEFAULT_AGENT_ID);
    skillAvailability = skills.length > 0 ? "enabled" : "none";
  } catch (error) {
    console.error("Tool catalog could not determine enabled skill state", error);
  }

  return buildToolCatalogSnapshot({
    specs: catalogToolSpecs,
    classification: catalogClassification,
    mode: resolveToolExposureMode(process.env.TOOL_EXPOSURE_MODE),
    skillAvailability,
    memorySearchEnabled: isMemorySearchEnabled(),
    profileExplicitWriteEnabled: isProfileExplicitWriteEnabled(),
    conversationSearchEnabled: isConversationSearchEnabled(),
    asOf: new Date().toISOString(),
  });
}
