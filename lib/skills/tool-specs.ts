import type { ToolSet } from "ai";

import {
  buildSpecToolSet,
  type RealisticToolInput,
  type RealisticToolSpec,
} from "@/lib/mock-tools";
import { activateSkill, loadSkillReference } from "@/lib/skills/catalog";
import {
  DEFAULT_AGENT_ID,
  SKILLS_UNAVAILABLE_MESSAGE,
  searchSkillsByDescription,
} from "@/lib/skills/skills";
import { isUuid } from "@/lib/skills/validation";

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 20;

export const skillToolSpecs: RealisticToolSpec[] = [
  {
    name: "skill_search",
    title: "Search skills",
    service: "skills",
    action: "search",
    description:
      "Search this agent's skills by matching the query against skill descriptions. Returns matching skills and reference documents with their ids. Load the content of a hit with skill_get_content.",
    properties: {
      query: {
        type: "string",
        description: "Text matched against skill and reference descriptions.",
      },
      limit: {
        type: "integer",
        description: `Maximum number of matches to return. Default ${SEARCH_LIMIT_DEFAULT}.`,
        minimum: 1,
        maximum: SEARCH_LIMIT_MAX,
      },
    },
    required: ["query"],
  },
  {
    name: "skill_get_content",
    title: "Get skill content",
    service: "skills",
    action: "get",
    description:
      "Load the body content of a skill or reference document by its id. Skill ids come from the <available_skills> catalog or skill_search; reference ids are listed inside a loaded skill's <skill_references>.",
    properties: {
      id: {
        type: "string",
        description: "Id of the skill or reference to load.",
      },
    },
    required: ["id"],
  },
];

type SkillToolHandler = (input: RealisticToolInput) => Promise<unknown>;

/**
 * Per-tool handler bodies — the self-registering replacement for the former
 * switch(name) dispatch. The shared "skills unavailable" error mapping is
 * applied once when the bodies are wrapped below.
 */
const skillToolBodies: Record<string, SkillToolHandler> = {
  skill_search: async (input) => {
    const query = typeof input.query === "string" ? input.query.trim() : "";

    if (!query) {
      return { success: false, error: "query is required." };
    }

    const limit = clampLimit(input.limit);
    const matches = await searchSkillsByDescription(query, DEFAULT_AGENT_ID, limit);

    return {
      success: true,
      query,
      count: matches.length,
      matches,
      note:
        matches.length === 0
          ? "No skill descriptions matched. Try broader keywords."
          : "Call skill_get_content with a match id to load its content.",
    };
  },
  skill_get_content: async (input) => {
    // Postgres renders uuids lowercase; normalize so case-insensitive ids
    // survive the exact string comparisons in the lookup layer.
    const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";

    if (!id) {
      return { success: false, error: "id is required." };
    }

    if (!isUuid(id)) {
      return {
        success: false,
        error: `'${id}' is not a valid skill id. Ids are UUIDs from the <available_skills> catalog, skill_search results, or a skill's <skill_references> list.`,
      };
    }

    const content =
      (await activateSkill(id, DEFAULT_AGENT_ID)) ??
      (await loadSkillReference(id, DEFAULT_AGENT_ID));

    if (!content) {
      return {
        success: false,
        error: `No enabled skill or reference with id '${id}' was found. It may have been disabled or deleted; use skill_search or the <available_skills> catalog to find a current id.`,
      };
    }

    return { success: true, id, content };
  },
};

/**
 * The skill bodies wrapped in the shared error mapping (was the switch's
 * surrounding try/catch): any failure logs and returns the skills-unavailable
 * message. This wrapped map is what the central tool registry registers.
 */
export const skillToolHandlers: Record<string, SkillToolHandler> = Object.fromEntries(
  Object.entries(skillToolBodies).map(([name, body]) => [
    name,
    async (input: RealisticToolInput) => {
      try {
        return await body(input);
      } catch (error) {
        console.error(`Skill tool ${name} failed`, error);
        return { success: false, error: SKILLS_UNAVAILABLE_MESSAGE };
      }
    },
  ]),
);

export async function executeSkillTool(name: string, input: RealisticToolInput) {
  const handler = skillToolHandlers[name];

  if (!handler) {
    return { success: false, error: `'${name}' is not a skill tool.` };
  }

  return handler(input);
}

/** Real AI SDK tools, exposed directly whenever the agent has enabled skills. */
export const skillTools: ToolSet = buildSpecToolSet(skillToolSpecs, executeSkillTool);

function clampLimit(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return SEARCH_LIMIT_DEFAULT;
  }

  return Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.trunc(parsed)));
}
