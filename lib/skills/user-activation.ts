import type { UIMessage } from "ai";

import { activateSkill } from "@/lib/skills/catalog";
import { DEFAULT_AGENT_ID, getSkillIdByName } from "@/lib/skills/skills";
import { parseSkillCommand } from "@/lib/skills/slash-command";
import type { ChatMessageMetadata } from "@/lib/token-usage";

type ChatMessage = UIMessage<ChatMessageMetadata>;

/**
 * User-explicit activation (Agent Skills client guide, step 4): the composer
 * tags a user message with metadata.activatedSkill when it starts with a
 * /skill-name command, and this injects the tier-2 <skill_content> block into
 * that message so the model gets the instructions without a skill_get_content
 * round-trip.
 *
 * The client resends the raw transcript on every request, so injection is
 * re-applied here each time. Content is re-read from the database per request
 * (skill edits propagate mid-conversation), and only the first tagged
 * occurrence of each skill is injected so re-activations don't duplicate
 * instructions. Unknown or disabled names fail soft: the model sees the raw
 * /skill-name text and can fall back to skill_search.
 */
export async function injectUserActivatedSkill(
  message: ChatMessage,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<ChatMessage> {
  const skillName = readActivatedSkillName(message);
  if (!skillName) return message;
  const content = await loadSkillContentByName(skillName, agentId);
  return content ? prependToFirstTextPart(message, content) : message;
}

/** Legacy bulk helper retained for non-route callers. New chat runs project only the target turn. */
export async function injectUserActivatedSkills(
  messages: ChatMessage[],
  agentId: string = DEFAULT_AGENT_ID,
): Promise<ChatMessage[]> {
  const injectedSkillNames = new Set<string>();
  const result: ChatMessage[] = [];

  for (const message of messages) {
    const skillName = readActivatedSkillName(message);

    if (!skillName || injectedSkillNames.has(skillName)) {
      result.push(message);
      continue;
    }

    const content = await loadSkillContentByName(skillName, agentId);
    const injectedMessage = content ? prependToFirstTextPart(message, content) : message;

    if (injectedMessage !== message) {
      injectedSkillNames.add(skillName);
    }

    result.push(injectedMessage);
  }

  return result;
}

/**
 * Honors the metadata tag only when it matches a leading /skill-name in the
 * visible text, so every injection is explainable from the transcript alone.
 */
function readActivatedSkillName(message: ChatMessage) {
  if (message.role !== "user") {
    return null;
  }

  const tagged = message.metadata?.activatedSkill;

  if (!tagged || typeof tagged !== "string") {
    return null;
  }

  return parseSkillCommand(firstTextPart(message)?.text ?? "") === tagged ? tagged : null;
}

async function loadSkillContentByName(name: string, agentId: string) {
  try {
    const skillId = await getSkillIdByName(name, agentId);

    return skillId ? await activateSkill(skillId, agentId) : null;
  } catch (error) {
    console.error(`User-activated skill '${name}' could not be loaded`, error);
    return null;
  }
}

function firstTextPart(message: ChatMessage) {
  return message.parts.find((part) => part.type === "text");
}

function prependToFirstTextPart(message: ChatMessage, content: string): ChatMessage {
  let prepended = false;
  const parts = message.parts.map((part) => {
    if (part.type !== "text" || prepended) {
      return part;
    }

    prepended = true;
    return { ...part, text: `${content}\n\n${part.text}` };
  });

  return prepended ? { ...message, parts } : message;
}
