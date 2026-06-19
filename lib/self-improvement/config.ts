export const DEFAULT_MEMORY_REVIEW_INTERVAL = 10;
export const DEFAULT_TURN_REVIEW_DELAY_SECONDS = 10;

export function isSelfImprovementEnabled() {
  return process.env.SELF_IMPROVEMENT_ENABLED?.trim().toLowerCase() === "true";
}

export function getMemoryReviewInterval() {
  return parsePositiveInteger(
    process.env.SELF_IMPROVEMENT_MEMORY_INTERVAL,
    DEFAULT_MEMORY_REVIEW_INTERVAL,
  );
}

export function getTurnReviewDelaySeconds() {
  return parsePositiveInteger(
    process.env.SELF_IMPROVEMENT_REVIEW_DELAY_SECONDS,
    DEFAULT_TURN_REVIEW_DELAY_SECONDS,
  );
}

export function getReviewerModel(defaultModel: string) {
  return process.env.SELF_IMPROVEMENT_MODEL?.trim() || defaultModel;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
