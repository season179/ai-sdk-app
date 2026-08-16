import {
  isAutomaticProfileSynthesisEnabled,
  isProfileSynthesisEnabled,
} from "@/lib/profile/config";
import { enqueueProfileSynthesis, type ProfileAgentJobData } from "@/lib/profile/jobs";
import { markProfileDirty } from "@/lib/profile/repository";

export type MarkProfileDirtyResult =
  | { marked: false; jobId: null; reason: "disabled" }
  | { marked: true; jobId: string | null; dirtyGeneration: number };

/**
 * Post-commit profile invalidation boundary. Authoritative writers call this
 * only after their own transaction commits; queue failure leaves the monotonic
 * dirty generation for a later turn or daily sweep to recover.
 */
export async function markProfileDirtyAndEnqueue(
  agentId: string,
  options: {
    trigger: ProfileAgentJobData["trigger"];
    automatic?: boolean;
  },
): Promise<MarkProfileDirtyResult> {
  const enabled = profileDispatchEnabled(options.automatic);
  if (!enabled) return { marked: false, jobId: null, reason: "disabled" };
  const dirtyGeneration = await markProfileDirty(agentId);
  const jobId = await enqueueProfileSynthesis(agentId, { trigger: options.trigger });
  return { marked: true, jobId, dirtyGeneration };
}

/** Queue-only post-commit boundary for writers that dirtied atomically. */
export async function enqueueDirtyProfile(
  agentId: string,
  options: { trigger: ProfileAgentJobData["trigger"]; automatic?: boolean },
): Promise<string | null> {
  if (!profileDispatchEnabled(options.automatic)) return null;
  return enqueueProfileSynthesis(agentId, { trigger: options.trigger });
}

function profileDispatchEnabled(automatic?: boolean): boolean {
  return automatic ? isAutomaticProfileSynthesisEnabled() : isProfileSynthesisEnabled();
}
