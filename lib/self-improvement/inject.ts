import { isSelfImprovementEnabled } from "@/lib/self-improvement/config";
import { listApprovedMemories } from "@/lib/self-improvement/memories";
import { DEFAULT_AGENT_ID } from "@/lib/skills/skills";

export async function loadMemoryBlock(agentId: string = DEFAULT_AGENT_ID) {
  if (!isSelfImprovementEnabled()) {
    return "";
  }

  const memories = await listApprovedMemories(agentId);

  if (memories.length === 0) {
    return "";
  }

  const items = memories
    .map(
      (memory) =>
        `  <memory kind="${memory.kind}" confidence="${memory.confidence}">${escapeXml(memory.content)}</memory>`,
    )
    .join("\n");

  return `<declarative_memory>\n${items}\n</declarative_memory>`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
