import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("memory version-authority cutover", () => {
  it("locks both legacy writer tables before either delta snapshot", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "db/drizzle/0006_agent_memory_version_authority.sql"),
      "utf8",
    );
    const memoryLock = sql.indexOf('LOCK TABLE "agent_memories" IN SHARE ROW EXCLUSIVE MODE');
    const observationLock = sql.indexOf(
      'LOCK TABLE "agent_grounded_observations" IN SHARE ROW EXCLUSIVE MODE',
    );
    const observationDelta = sql.indexOf('INSERT INTO "agent_trace_events"');
    const memoryDelta = sql.indexOf('CREATE TEMP TABLE "_agent_memory_cutover"');
    expect(memoryLock).toBeGreaterThanOrEqual(0);
    expect(observationLock).toBeGreaterThanOrEqual(0);
    expect(memoryLock).toBeLessThan(observationDelta);
    expect(observationLock).toBeLessThan(observationDelta);
    expect(memoryLock).toBeLessThan(memoryDelta);
    expect(observationLock).toBeLessThan(memoryDelta);
  });
});
