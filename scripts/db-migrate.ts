import "@/lib/scheduler/load-env";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

// Applies the Drizzle migrations in db/drizzle (the single source of truth for
// our tables). Uses a short-lived Client rather than the app pool so the script
// exits cleanly. The baseline 0000 migration is idempotent, so this is safe
// against both a fresh database and one that already has the tables.
async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    console.error("DATABASE_URL is required to run migrations.");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await migrate(drizzle(client), { migrationsFolder: "db/drizzle" });
    console.log("Migrations complete.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration failed", error);
  process.exit(1);
});
