import { and, eq, sql } from "drizzle-orm";

import { type AppDbTransaction, getDb } from "@/db";
import { agentProfiles, agentProfileVersions } from "@/db/schema";
import type {
  ProfileFactV1,
  ProfileVersionAuthority,
  ProfileVersionTrigger,
} from "@/lib/profile/types";

export type ProfileVersionForRun = {
  id: string;
  agentId: string;
  versionNo: number;
  body: string;
  facts: ProfileFactV1[];
  authority: ProfileVersionAuthority;
  trigger: ProfileVersionTrigger;
  createdAt: Date;
  tokenCount: number;
};

export type ProfileReadOptions = {
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Observability only; reads still fail open to null. */
  onFailure?: (error: unknown) => void;
};

const profileVersionSelection = {
  id: agentProfileVersions.id,
  agentId: agentProfileVersions.agentId,
  versionNo: agentProfileVersions.versionNo,
  body: agentProfileVersions.body,
  facts: agentProfileVersions.facts,
  authority: agentProfileVersions.authority,
  trigger: agentProfileVersions.trigger,
  createdAt: agentProfileVersions.createdAt,
  tokenCount: agentProfileVersions.tokenCount,
};

export async function getCurrentProfileVersionForRun(
  agentId: string,
  options: ProfileReadOptions = {},
): Promise<ProfileVersionForRun | null> {
  return readFailOpen(options, async (tx) => {
    const [row] = await tx
      .select(profileVersionSelection)
      .from(agentProfiles)
      .innerJoin(agentProfileVersions, eq(agentProfiles.currentVersionId, agentProfileVersions.id))
      .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfileVersions.agentId, agentId)))
      .limit(1);
    return row ?? null;
  });
}

export async function getProfileVersionForRun(
  versionId: string,
  agentId: string,
  options: ProfileReadOptions = {},
): Promise<ProfileVersionForRun | null> {
  return readFailOpen(options, async (tx) => {
    const [row] = await tx
      .select(profileVersionSelection)
      .from(agentProfileVersions)
      .where(and(eq(agentProfileVersions.id, versionId), eq(agentProfileVersions.agentId, agentId)))
      .limit(1);
    return row ?? null;
  });
}

async function readFailOpen(
  options: ProfileReadOptions,
  query: (tx: AppDbTransaction) => Promise<ProfileVersionForRun | null>,
): Promise<ProfileVersionForRun | null> {
  try {
    throwIfExpired(options);
    return await getDb().transaction(async (tx) => {
      throwIfExpired(options);
      const remaining = options.deadlineAt === undefined ? 2_000 : options.deadlineAt - Date.now();
      const statementTimeoutMs = Math.max(1, Math.min(2_000, remaining));
      await tx.execute(
        sql`select set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`,
      );
      throwIfExpired(options);
      return query(tx);
    });
  } catch (error) {
    try {
      options.onFailure?.(error);
    } catch {
      // Observability hooks cannot turn an optional read into a chat failure.
    }
    return null;
  }
}

function throwIfExpired(options: ProfileReadOptions): void {
  if (
    options.signal?.aborted ||
    (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
  ) {
    throw new Error("profile_read_deadline_exceeded");
  }
}
