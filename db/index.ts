import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { getPool } from "@/lib/scheduler/db";

let cachedPool: ReturnType<typeof getPool> | undefined;
let cachedDb: NodePgDatabase<typeof schema> | undefined;

/**
 * Drizzle client bound to the shared scheduler pool — never a second pool.
 * Rebuilt only when getPool() hands back a different pool (e.g. after
 * closePool() in tests), and constructed lazily so an unset DATABASE_URL still
 * fails inside the caller's fail-soft path rather than at import time.
 */
export function getDb(): NodePgDatabase<typeof schema> {
  const pool = getPool();

  if (cachedPool !== pool || !cachedDb) {
    cachedPool = pool;
    cachedDb = drizzle(pool, { schema });
  }

  return cachedDb;
}

export { schema };
