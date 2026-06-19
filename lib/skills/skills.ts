import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { type AppDbClient, getDb } from "@/db";
import { agentSkills } from "@/db/schema";
import {
  validateDescription,
  validateName,
  validateReferenceBody,
  validateSkillBody,
} from "@/lib/skills/validation";

// Row-shape invariant: every insert below hardcodes its type — 'skill' rows
// never get a parent_id, 'reference' rows always do. The DB backstops this
// with the agent_skills_parent_shape check constraint, so a row with a
// parent_id can only ever be a 'reference'.

/**
 * Single-agent app: every row uses this id, mirroring the column default in
 * db/migrations/002_skills.sql. When multi-agent arrives, thread real ids
 * through instead.
 */
export const DEFAULT_AGENT_ID = "00000000-0000-0000-0000-000000000001";

/** Operator hint shown when the database is unreachable; shared by API and tool layers. */
export const SKILLS_UNAVAILABLE_MESSAGE =
  "Skills are unavailable. Check that Postgres is running and DATABASE_URL is set.";

export type SkillReference = {
  id: string;
  name: string;
  description: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type Skill = {
  id: string;
  name: string;
  description: string;
  body: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  references: SkillReference[];
};

export type SkillReferenceInput = {
  /** Present when updating an existing reference; omitted for new ones. */
  id?: string;
  name: string;
  description: string;
  body: string;
};

export type CreateSkillInput = {
  name: string;
  description: string;
  body: string;
  references?: SkillReferenceInput[];
};

export type UpdateSkillInput = {
  name?: string;
  description?: string;
  body?: string;
  isEnabled?: boolean;
  /**
   * Replace-set semantics: when provided, references with an id are updated,
   * ones without an id are created, and live references missing from the
   * list are soft-deleted.
   */
  references?: SkillReferenceInput[];
};

export class SkillInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInputError";
  }
}

export class SkillNotFoundError extends SkillInputError {
  constructor(id: string) {
    super(`No skill with id '${id}' was found.`);
    this.name = "SkillNotFoundError";
  }
}

// Selected columns are inferred from $inferSelect; the mappers below pick only
// what they read, so any projection covering those fields is accepted.
type SkillRow = typeof agentSkills.$inferSelect;

// Shared projection: the live, app-facing skill/reference columns.
const skillColumns = {
  id: agentSkills.id,
  parentId: agentSkills.parentId,
  type: agentSkills.type,
  name: agentSkills.name,
  description: agentSkills.description,
  body: agentSkills.body,
  isEnabled: agentSkills.isEnabled,
  createdAt: agentSkills.createdAt,
  updatedAt: agentSkills.updatedAt,
} as const;

export async function listSkills(agentId: string = DEFAULT_AGENT_ID) {
  const rows = await getDb()
    .select(skillColumns)
    .from(agentSkills)
    .where(and(eq(agentSkills.agentId, agentId), isNull(agentSkills.deletedAt)))
    .orderBy(asc(agentSkills.createdAt));

  const skills = rows
    .filter((row) => row.type === "skill")
    .map((row) => mapSkillRow(row))
    .reverse();
  const byId = new Map(skills.map((skill) => [skill.id, skill]));

  for (const row of rows) {
    if (row.type !== "reference" || !row.parentId) {
      continue;
    }

    byId.get(row.parentId)?.references.push(mapReferenceRow(row));
  }

  return skills;
}

export async function getSkillById(
  id: string,
  agentId: string = DEFAULT_AGENT_ID,
  db: AppDbClient = getDb(),
) {
  const rows = await db
    .select(skillColumns)
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        isNull(agentSkills.deletedAt),
        or(eq(agentSkills.id, id), eq(agentSkills.parentId, id)),
      ),
    )
    .orderBy(asc(agentSkills.createdAt));

  const skillRow = rows.find((row) => row.id === id && row.type === "skill");

  if (!skillRow) {
    return null;
  }

  const skill = mapSkillRow(skillRow);

  for (const row of rows) {
    if (row.type === "reference" && row.parentId === id) {
      skill.references.push(mapReferenceRow(row));
    }
  }

  return skill;
}

/**
 * Loads a single live reference row by id (tier-3 resource lookup). The parent
 * skill must be live and enabled: disabling a skill hides its references from
 * the agent too.
 */
export async function getReferenceById(id: string, agentId: string = DEFAULT_AGENT_ID) {
  const parent = alias(agentSkills, "parent");
  const rows = await getDb()
    .select(skillColumns)
    .from(agentSkills)
    .innerJoin(
      parent,
      and(
        eq(parent.id, agentSkills.parentId),
        eq(parent.agentId, agentSkills.agentId),
        isNull(parent.deletedAt),
        eq(parent.isEnabled, true),
      ),
    )
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.id, id),
        eq(agentSkills.type, "reference"),
        isNull(agentSkills.deletedAt),
      ),
    );

  return rows[0] ? mapReferenceRow(rows[0]) : null;
}

/**
 * Narrow tier-1 projection for the agent's catalog: enabled skills only,
 * newest first, without dragging body columns onto the chat hot path.
 */
export async function listSkillCatalogEntries(agentId: string = DEFAULT_AGENT_ID) {
  const rows = await getDb()
    .select({
      id: agentSkills.id,
      name: agentSkills.name,
      description: agentSkills.description,
    })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.type, "skill"),
        eq(agentSkills.isEnabled, true),
        isNull(agentSkills.deletedAt),
      ),
    )
    .orderBy(desc(agentSkills.createdAt));

  return rows;
}

/**
 * Resolves an enabled, live skill's id by exact name. Used for user-explicit
 * activation, where the /skill-name command carries a name, not an id.
 */
export async function getSkillIdByName(name: string, agentId: string = DEFAULT_AGENT_ID) {
  const rows = await getDb()
    .select({ id: agentSkills.id })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.type, "skill"),
        eq(agentSkills.name, name),
        eq(agentSkills.isEnabled, true),
        isNull(agentSkills.deletedAt),
      ),
    );

  return rows[0]?.id ?? null;
}

export type SkillSearchHit = {
  id: string;
  type: "skill" | "reference";
  name: string;
  description: string;
  /** For reference hits: the id of the skill the reference belongs to. */
  skillId: string | null;
};

/**
 * Searches the description column of live rows for an agent. Skill hits must
 * be enabled; reference hits must belong to an enabled skill.
 */
export async function searchSkillsByDescription(
  query: string,
  agentId: string = DEFAULT_AGENT_ID,
  limit = 10,
): Promise<SkillSearchHit[]> {
  const trimmed = query.trim();

  if (!trimmed) {
    return [];
  }

  // No ESCAPE clause: Postgres' default LIKE escape character is already the
  // backslash that escapeLikePattern emits.
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  const parent = alias(agentSkills, "parent");
  const rows = await getDb()
    .select({
      id: agentSkills.id,
      parentId: agentSkills.parentId,
      type: agentSkills.type,
      name: agentSkills.name,
      description: agentSkills.description,
    })
    .from(agentSkills)
    .leftJoin(
      parent,
      and(eq(parent.id, agentSkills.parentId), eq(parent.agentId, agentSkills.agentId)),
    )
    .where(
      and(
        eq(agentSkills.agentId, agentId),
        isNull(agentSkills.deletedAt),
        ilike(agentSkills.description, pattern),
        or(
          and(eq(agentSkills.type, "skill"), eq(agentSkills.isEnabled, true)),
          and(
            eq(agentSkills.type, "reference"),
            isNull(parent.deletedAt),
            eq(parent.isEnabled, true),
          ),
        ),
      ),
    )
    .orderBy(sql`(${agentSkills.type} = 'skill') desc`, asc(agentSkills.name))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    skillId: row.parentId,
  }));
}

export async function createSkill(input: CreateSkillInput, db: AppDbClient = getDb()) {
  const name = parseName(input.name);
  const description = parseDescription(input.description);
  const body = parseBody(input.body);
  const references = (input.references ?? []).map(parseReferenceInput);

  const id = randomUUID();

  try {
    await runInTransaction(db, async (tx) => {
      await tx.insert(agentSkills).values({
        id,
        agentId: DEFAULT_AGENT_ID,
        type: "skill",
        name,
        description,
        body,
      });

      for (const reference of references) {
        await tx.insert(agentSkills).values({
          id: randomUUID(),
          agentId: DEFAULT_AGENT_ID,
          parentId: id,
          type: "reference",
          name: reference.name,
          description: reference.description,
          body: reference.body,
        });
      }
    });
  } catch (error) {
    throw translateDbError(error, name);
  }

  return requireSkill(id, db);
}

export async function updateSkill(id: string, input: UpdateSkillInput, db: AppDbClient = getDb()) {
  const existing = await requireSkill(id, db);

  const name = input.name === undefined ? existing.name : parseName(input.name);
  const description =
    input.description === undefined ? existing.description : parseDescription(input.description);
  const body = input.body === undefined ? existing.body : parseBody(input.body);
  const isEnabled = input.isEnabled === undefined ? existing.isEnabled : input.isEnabled;
  const references = input.references?.map(parseReferenceInput);

  try {
    await runInTransaction(db, async (tx) => {
      await tx
        .update(agentSkills)
        .set({ name, description, body, isEnabled, updatedAt: sql`now()` })
        .where(
          and(eq(agentSkills.id, id), eq(agentSkills.type, "skill"), isNull(agentSkills.deletedAt)),
        );

      if (references) {
        const liveIds = new Set(existing.references.map((reference) => reference.id));
        const keptIds = new Set<string>();

        for (const reference of references) {
          if (reference.id) {
            if (!liveIds.has(reference.id)) {
              throw new SkillInputError(
                `Reference '${reference.id}' does not belong to this skill.`,
              );
            }

            keptIds.add(reference.id);
            await tx
              .update(agentSkills)
              .set({
                name: reference.name,
                description: reference.description,
                body: reference.body,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(agentSkills.id, reference.id),
                  eq(agentSkills.parentId, id),
                  isNull(agentSkills.deletedAt),
                ),
              );
          } else {
            await tx.insert(agentSkills).values({
              id: randomUUID(),
              agentId: DEFAULT_AGENT_ID,
              parentId: id,
              type: "reference",
              name: reference.name,
              description: reference.description,
              body: reference.body,
            });
          }
        }

        const removedIds = [...liveIds].filter((liveId) => !keptIds.has(liveId));

        if (removedIds.length > 0) {
          await tx
            .update(agentSkills)
            .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
            .where(
              and(
                eq(agentSkills.parentId, id),
                inArray(agentSkills.id, removedIds),
                isNull(agentSkills.deletedAt),
              ),
            );
        }
      }
    });
  } catch (error) {
    throw translateDbError(error, name);
  }

  return requireSkill(id, db);
}

/** Soft delete only: stamps deleted_at on the skill and its live references. */
export async function deleteSkill(id: string) {
  await requireSkill(id);

  // db.transaction() rolls back and rethrows on any error, so no manual handling.
  await getDb().transaction(async (tx) => {
    await tx
      .update(agentSkills)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          or(eq(agentSkills.id, id), eq(agentSkills.parentId, id)),
          isNull(agentSkills.deletedAt),
        ),
      );
  });
}

// --- Internals ---------------------------------------------------------------

function escapeLikePattern(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function runInTransaction(
  db: AppDbClient,
  fn: (tx: AppDbClient) => Promise<void>,
): Promise<void> {
  if (db === getDb()) {
    await db.transaction(fn);
    return;
  }

  await fn(db);
}

async function requireSkill(id: string, db: AppDbClient = getDb()) {
  const skill = await getSkillById(id, DEFAULT_AGENT_ID, db);

  if (!skill) {
    throw new SkillNotFoundError(id);
  }

  return skill;
}

function parseName(value: string) {
  const name = value?.trim() ?? "";
  const error = validateName(name);

  if (error) {
    throw new SkillInputError(error);
  }

  return name;
}

function parseDescription(value: string) {
  const description = value?.trim() ?? "";
  const error = validateDescription(description);

  if (error) {
    throw new SkillInputError(error);
  }

  return description;
}

function parseBody(value: string) {
  const body = value?.trim() ?? "";
  const error = validateSkillBody(body);

  if (error) {
    throw new SkillInputError(error);
  }

  return body;
}

function parseReferenceBody(value: string) {
  const body = value?.trim() ?? "";
  const error = validateReferenceBody(body);

  if (error) {
    throw new SkillInputError(error);
  }

  return body;
}

function parseReferenceInput(input: SkillReferenceInput): Required<SkillReferenceInput> {
  return {
    id: input.id ?? "",
    name: parseName(input.name),
    description: parseDescription(input.description),
    body: parseReferenceBody(input.body),
  };
}

function translateDbError(error: unknown, skillName: string) {
  const pgError = asPgError(error);

  if (pgError?.code === "23505") {
    const constraint = pgError.constraint ?? "";

    if (constraint === "agent_skills_reference_name_uniq") {
      return new SkillInputError("Reference names must be unique within a skill.");
    }

    return new SkillInputError(`A skill named '${skillName}' already exists.`);
  }

  return error;
}

// Drizzle wraps driver errors in DrizzleQueryError with the original pg error
// on `.cause`; check both that and the error itself so the unique-violation
// code/constraint stay reachable however the error surfaces.
function asPgError(error: unknown): { code?: string; constraint?: string } | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      return candidate as { code?: string; constraint?: string };
    }
  }

  return null;
}

function mapSkillRow(
  row: Pick<
    SkillRow,
    "id" | "name" | "description" | "body" | "isEnabled" | "createdAt" | "updatedAt"
  >,
): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    references: [],
  };
}

function mapReferenceRow(
  row: Pick<SkillRow, "id" | "name" | "description" | "body" | "createdAt" | "updatedAt">,
): SkillReference {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
