import "@/lib/scheduler/load-env";

import { pathToFileURL } from "node:url";

import { PgBoss } from "pg-boss";

import { getPgBossSchema, requireDatabaseUrl } from "@/lib/scheduler/env";

const PROFILE_QUEUE = "agent-profile-synthesis";
const PROFILE_DLQ = "agent-profile-synthesis-dlq";
const PROFILE_SCHEDULE = "agent-profile-synthesis-schedule";

export type ProfileRetirementBoss = Pick<
  PgBoss,
  "start" | "stop" | "unschedule" | "deleteQueue" | "getSchedules"
>;

/** Remove the obsolete profile cron and both queues without preparing app queues. */
export async function retireProfileSynthesis(boss: ProfileRetirementBoss): Promise<void> {
  try {
    await boss.start();

    try {
      await boss.unschedule(PROFILE_QUEUE, PROFILE_SCHEDULE);
    } catch {
      // A missing schedule is already retired. Verification below still catches
      // a schedule that survived a real failure.
    }

    await boss.deleteQueue(PROFILE_QUEUE);
    await boss.deleteQueue(PROFILE_DLQ);

    const schedules = await boss.getSchedules(PROFILE_QUEUE);
    if (schedules.length > 0) {
      throw new Error("Profile synthesis schedule still exists after retirement.");
    }
  } finally {
    await boss.stop({ graceful: true });
  }
}

async function main(): Promise<void> {
  const boss = new PgBoss({
    connectionString: requireDatabaseUrl(),
    schema: getPgBossSchema(),
  });

  boss.on("error", (error) => console.error("pg-boss error", error));
  boss.on("warning", (warning) => console.warn("pg-boss warning", warning));

  await retireProfileSynthesis(boss);
  console.log("Profile synthesis schedule and queues retired.");
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    console.error("Profile synthesis retirement failed", error);
    process.exitCode = 1;
  });
}
