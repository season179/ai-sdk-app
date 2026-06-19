import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { jsonSchema, Output, ToolLoopAgent } from "ai";

import { type ChatUIMessage, getChatSession } from "@/lib/chat/sessions";
import { getReviewerModel } from "@/lib/self-improvement/config";
import { createReviewProposal } from "@/lib/self-improvement/proposals";
import { getSkillCatalog } from "@/lib/skills/catalog";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

// The kinds the autonomous reviewer may emit — a deliberate subset of the full
// ReviewProposalKind in db/schema.ts (memory_edit/memory_archive stay manual).
// Single source for both the draft type and the output-schema enum below.
const REVIEWER_PROPOSAL_KINDS = [
  "memory_create",
  "skill_create",
  "skill_edit",
  "skill_toggle",
] as const;

type ReviewerProposalKind = (typeof REVIEWER_PROPOSAL_KINDS)[number];

type ReviewProposalDraft = {
  kind: ReviewerProposalKind;
  rationale: string;
  payload: Record<string, unknown>;
};

type ReviewVerdict = {
  summary: string;
  noActionReason: string;
  proposals: ReviewProposalDraft[];
};

export type RunTurnReviewResult = {
  proposalCount: number;
  summary: string;
  noActionReason: string;
};

export class MissingReviewRunnerEnvError extends Error {
  constructor(readonly variableName: "OPENROUTER_API_KEY" | "OPENROUTER_DEFAULT_MODEL") {
    super(
      `${variableName} is required: the turn-review worker runs self-improvement review through OpenRouter.`,
    );
    this.name = "MissingReviewRunnerEnvError";
  }
}

const REVIEW_SYSTEM_PROMPT = [
  "You are a conservative self-improvement reviewer for an AI SDK app.",
  "Your job is to propose durable learning only when the completed conversation contains reusable facts, preferences, corrections, or procedural lessons.",
  "Prefer no action. Do not store raw transcripts, transient errors, ordinary task summaries, or guesses.",
  "Memory is declarative: stable user preferences, durable facts, persona expectations, or corrections.",
  "Skills are procedural: reusable instructions for a class of future tasks.",
  "You may also refine an existing skill (skill_edit) or disable a misbehaving one (skill_toggle), but only by referencing a skill id listed in the prompt — never invent or guess an id.",
  "You do not modify live state. You only return pending proposals for human approval.",
  "Return at most 3 proposals.",
].join(" ");

const reviewVerdictSchema = jsonSchema<ReviewVerdict>({
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "One concise sentence summarizing the review.",
    },
    noActionReason: {
      type: "string",
      description: "Why no proposal is needed. Use an empty string when proposals are present.",
    },
    proposals: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...REVIEWER_PROPOSAL_KINDS],
          },
          rationale: {
            type: "string",
          },
          payload: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["kind", "rationale", "payload"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "noActionReason", "proposals"],
  additionalProperties: false,
});

export async function runTurnReview({
  agentId = DEFAULT_AGENT_ID,
  sessionId,
  triggerMessageId,
}: {
  agentId?: string;
  sessionId: string;
  triggerMessageId: string;
}): Promise<RunTurnReviewResult> {
  const session = await getChatSession(sessionId, agentId);

  if (!session) {
    return {
      proposalCount: 0,
      summary: "Session was not available for review.",
      noActionReason: "The session was deleted or not found.",
    };
  }

  const { apiKey, model } = requireReviewRunnerEnv();
  const openrouter = createOpenRouter({ apiKey });
  const [skillCatalog, transcript] = await Promise.all([
    getSkillCatalog(agentId).catch((error) => {
      console.error("Skill catalog unavailable for self-improvement review", error);
      return [];
    }),
    Promise.resolve(formatTranscript(session.messages)),
  ]);

  const agent = new ToolLoopAgent({
    instructions: REVIEW_SYSTEM_PROMPT,
    model: openrouter.chat(model),
    output: Output.object({ schema: reviewVerdictSchema }),
  });

  const result = await agent.generate({
    prompt: buildReviewPrompt({ triggerMessageId, transcript, skillCatalog }),
  });
  const verdict = result.output;

  if (!verdict) {
    throw new Error("Turn review ended without a structured verdict.");
  }

  const validSkillIds = new Set(skillCatalog.map((skill) => skill.id));
  const applicable = selectApplicableProposals(verdict.proposals.slice(0, 3), validSkillIds);

  let proposalCount = 0;
  for (const proposal of applicable) {
    await createReviewProposal({
      agentId,
      sessionId,
      triggerMessageId,
      kind: proposal.kind,
      payload: proposal.payload,
      rationale: proposal.rationale,
      reviewerModel: model,
    });
    proposalCount += 1;
  }

  return {
    proposalCount,
    summary: verdict.summary,
    noActionReason: verdict.noActionReason,
  };
}

/**
 * Drop skill_edit/skill_toggle drafts the apply path can't honor: a missing or
 * non-live skillId, a skill_toggle with no boolean isEnabled, or a skill_edit
 * that carries no usable change. The reviewer is an LLM that can hallucinate ids
 * or emit incomplete payloads; filtering here keeps a doomed, no-op, or
 * destructive skill proposal out of the queue and the apply path entirely.
 * memory_create/skill_create carry no existing-entity reference and always pass
 * through. Exported as a pure function so it can be unit-tested without a model
 * or database.
 */
export function selectApplicableProposals(
  proposals: ReviewProposalDraft[],
  validSkillIds: ReadonlySet<string>,
): ReviewProposalDraft[] {
  return proposals.filter((proposal) => {
    if (proposal.kind !== "skill_edit" && proposal.kind !== "skill_toggle") {
      return true;
    }

    const { payload } = proposal;
    const skillId = payload.skillId;

    if (typeof skillId !== "string") {
      return dropProposal(proposal, "payload has no string skillId");
    }

    if (!validSkillIds.has(skillId)) {
      return dropProposal(proposal, `skillId '${skillId}' is not a live enabled skill`);
    }

    if (proposal.kind === "skill_toggle") {
      // apply.ts reads isEnabled with readRequiredBoolean — a non-boolean would
      // throw at approval time and leave a failed proposal in the queue.
      if (typeof payload.isEnabled !== "boolean") {
        return dropProposal(proposal, "skill_toggle has no boolean isEnabled");
      }

      return true;
    }

    // skill_edit: the reviewer never sees a skill's reference documents, and an
    // empty references array would soft-delete every reference at apply time
    // (updateSkill treats [] as replace-all), so it may not touch references —
    // only description/body, at least one of which must be a real change.
    if ("references" in payload) {
      return dropProposal(proposal, "skill_edit may not modify references");
    }

    if (!isNonEmptyString(payload.description) && !isNonEmptyString(payload.body)) {
      return dropProposal(proposal, "skill_edit has no description or body change");
    }

    return true;
  });
}

function dropProposal(proposal: ReviewProposalDraft, reason: string): false {
  console.warn(`Dropping ${proposal.kind} proposal: ${reason}.`);
  return false;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function requireReviewRunnerEnv() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    throw new MissingReviewRunnerEnvError("OPENROUTER_API_KEY");
  }

  const defaultModel = process.env.OPENROUTER_DEFAULT_MODEL?.trim();

  if (!defaultModel) {
    throw new MissingReviewRunnerEnvError("OPENROUTER_DEFAULT_MODEL");
  }

  return { apiKey, model: getReviewerModel(defaultModel) };
}

function buildReviewPrompt({
  triggerMessageId,
  transcript,
  skillCatalog,
}: {
  triggerMessageId: string;
  transcript: string;
  skillCatalog: Awaited<ReturnType<typeof getSkillCatalog>>;
}) {
  const skills =
    skillCatalog.length === 0
      ? "No enabled skills are currently registered."
      : skillCatalog
          .map((skill) => `- ${skill.name} (${skill.id}): ${skill.description}`)
          .join("\n");

  return [
    `Review the completed conversation through assistant message id ${triggerMessageId}.`,
    "",
    "Available enabled skills:",
    skills,
    "",
    "Allowed proposal payloads:",
    "- memory_create: { memoryKind: 'preference'|'fact'|'correction'|'persona', content: string, confidence?: 0..100 }",
    "- skill_create: { name: lowercase-hyphen-name, description: string, body: string, references?: [] }",
    "- skill_edit: { skillId: <an id from the enabled skills list above>, description?: string, body?: string }",
    "- skill_toggle: { skillId: <an id from the enabled skills list above>, isEnabled: false }",
    "",
    "skill_edit and skill_toggle must set skillId to an id that appears verbatim in the enabled skills list above; never invent an id. skill_edit must change the description and/or body — it cannot touch a skill's reference documents — and should only rewrite a body when this conversation fully specifies the replacement. That list shows only enabled skills, so skill_toggle is for disabling one that misbehaved (isEnabled: false).",
    "",
    "Transcript excerpt:",
    transcript,
  ].join("\n");
}

function formatTranscript(messages: ChatUIMessage[]) {
  // Keep the latest turn visible under a conservative character budget; the
  // reviewer is cadence-based, so recent context matters more than old context.
  return messages
    .slice(-24)
    .map((message) => {
      const text = message.parts
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n")
        .trim();

      return `${message.role.toUpperCase()} ${message.id}:\n${text || "[no visible text]"}`;
    })
    .join("\n\n")
    .slice(-24_000);
}
