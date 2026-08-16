import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RealisticToolSpec } from "@/lib/mock-tools";
import {
  buildToolCatalogSnapshot,
  catalogClassification,
  catalogToolSpecs,
  memoryToolSpecNames,
  mockToolSpecNames,
  realToolSpecNames,
  type SkillAvailability,
  schedulerToolSpecNames,
  skillToolSpecNames,
  type ToolExposureMode,
} from "@/lib/tools/catalog-view";

const AS_OF = "2026-01-01T00:00:00.000Z";

function build(
  options: {
    mode?: ToolExposureMode;
    skillAvailability?: SkillAvailability;
    memorySearchEnabled?: boolean;
    conversationSearchEnabled?: boolean;
  } = {},
) {
  return buildToolCatalogSnapshot({
    specs: catalogToolSpecs,
    classification: catalogClassification,
    mode: options.mode ?? "search",
    skillAvailability: options.skillAvailability ?? "none",
    memorySearchEnabled: options.memorySearchEnabled ?? false,
    conversationSearchEnabled: options.conversationSearchEnabled ?? false,
    asOf: AS_OF,
  });
}

function getTool(snapshot: ReturnType<typeof build>, name: string) {
  const tool = snapshot.tools.find((candidate) => candidate.name === name);
  expect(tool, `expected catalog tool '${name}'`).toBeDefined();
  if (!tool) throw new Error(`Missing catalog tool '${name}'.`);
  return tool;
}

const fixtureSpec: RealisticToolSpec = {
  name: "fixture_tool",
  title: "Fixture tool",
  service: "fixture",
  action: "test",
  description: "A test fixture.",
  properties: {},
};

describe("buildToolCatalogSnapshot", () => {
  it("classifies every live catalog spec and pins the source counts", () => {
    const snapshot = build();

    expect(mockToolSpecNames.size).toBe(200);
    expect(schedulerToolSpecNames.size).toBe(6);
    expect(skillToolSpecNames.size).toBe(2);
    expect(memoryToolSpecNames.size).toBe(2);
    expect(realToolSpecNames.size).toBe(10);
    expect(snapshot.counts).toMatchObject({ total: 210, mocked: 200, real: 10 });
    expect(
      snapshot.tools.filter((tool) => tool.backing === "mocked").map((tool) => tool.name),
    ).toEqual(expect.arrayContaining([...mockToolSpecNames]));
    expect(
      snapshot.tools.filter((tool) => tool.backing === "real").map((tool) => tool.name),
    ).toEqual(expect.arrayContaining([...realToolSpecNames]));
  });

  it("mirrors search mode with three direct bridge tools and all registry tools searchable", () => {
    const snapshot = build({ mode: "search" });

    expect(snapshot.bridgeToolCount).toBe(3);
    expect(snapshot.counts).toMatchObject({ direct: 0, bridgeReachable: 208, unavailable: 2 });
    expect(getTool(snapshot, "github_search_repositories")).toMatchObject({
      direct: false,
      bridgeReachable: true,
    });
    expect(getTool(snapshot, "memory_search")).toMatchObject({
      direct: false,
      bridgeReachable: false,
    });
  });

  it("mirrors all mode with 206 base catalog tools direct and no bridge", () => {
    const snapshot = build({ mode: "all" });

    expect(snapshot.bridgeToolCount).toBe(0);
    expect(snapshot.counts).toMatchObject({ direct: 206, bridgeReachable: 0, unavailable: 4 });
    expect(getTool(snapshot, "scheduled_task_create")).toMatchObject({
      direct: true,
      bridgeReachable: false,
    });
  });

  it("keeps skill tools bridge-reachable with zero skills and adds direct access when enabled", () => {
    const withoutSkills = build({ mode: "search", skillAvailability: "none" });
    const withSkills = build({ mode: "search", skillAvailability: "enabled" });

    for (const name of skillToolSpecNames) {
      expect(getTool(withoutSkills, name)).toMatchObject({
        direct: false,
        bridgeReachable: true,
      });
      expect(getTool(withSkills, name)).toMatchObject({
        direct: true,
        bridgeReachable: true,
      });
    }
  });

  it("gates both direct-only search tools independently and never bridges them", () => {
    for (const mode of ["search", "all"] as const) {
      expect(getTool(build({ mode, memorySearchEnabled: false }), "memory_search")).toMatchObject({
        direct: false,
        bridgeReachable: false,
      });
      expect(getTool(build({ mode, memorySearchEnabled: true }), "memory_search")).toMatchObject({
        direct: true,
        bridgeReachable: false,
      });
      expect(
        getTool(build({ mode, conversationSearchEnabled: false }), "conversation_time_search"),
      ).toMatchObject({ direct: false, bridgeReachable: false });
      expect(
        getTool(build({ mode, conversationSearchEnabled: true }), "conversation_time_search"),
      ).toMatchObject({ direct: true, bridgeReachable: false });
    }
  });

  it("fails soft to an unknown skill state while preserving search bridge access", () => {
    const snapshot = build({ mode: "search", skillAvailability: "unknown" });

    expect(snapshot.warning).toContain("could not be loaded");
    expect(getTool(snapshot, "skill_search")).toMatchObject({
      direct: false,
      bridgeReachable: true,
    });
  });

  it("rejects duplicate catalog names", () => {
    expect(() =>
      buildToolCatalogSnapshot({
        specs: [fixtureSpec, fixtureSpec],
        classification: {
          mockedNames: new Set([fixtureSpec.name]),
          realNames: new Set(),
          skillNames: new Set(),
          memoryNames: new Set(),
        },
        mode: "search",
        skillAvailability: "none",
        memorySearchEnabled: false,
        conversationSearchEnabled: false,
        asOf: AS_OF,
      }),
    ).toThrow("Duplicate catalog tool name 'fixture_tool'.");
  });

  it("rejects unclassified catalog names", () => {
    expect(() =>
      buildToolCatalogSnapshot({
        specs: [fixtureSpec],
        classification: {
          mockedNames: new Set(),
          realNames: new Set(),
          skillNames: new Set(),
          memoryNames: new Set(),
        },
        mode: "search",
        skillAvailability: "none",
        memorySearchEnabled: false,
        conversationSearchEnabled: false,
        asOf: AS_OF,
      }),
    ).toThrow("Catalog tool 'fixture_tool' is unclassified.");
  });
});
