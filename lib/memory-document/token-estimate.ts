import "server-only";

export const MEMORY_INDEX_TOKEN_LIMIT = 1_000;
export const MEMORY_DETAILS_TOKEN_LIMIT = 4_000;
export const MEMORY_ENTRY_TOKEN_LIMIT = 1_200;
export const MEMORY_READ_TOKEN_LIMIT = 2_000;

export function estimateTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 4);
}
