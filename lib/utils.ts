import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Canonical UUID shape shared by the chat route and the client shell. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Fetch a JSON API response shaped like `{ [key]: T; error?: string }` and
 * return the keyed value, throwing the server's `error` (or a fallback) when
 * the request fails or the value is absent. Tolerates a non-JSON error body
 * (e.g. an HTML 500 page) instead of throwing an opaque SyntaxError.
 */
export async function fetchJson<T>(url: string, key: string, fallbackError: string): Promise<T> {
  const response = await fetch(url);
  const parsed = (await response.json().catch(() => null)) as unknown;
  const body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown> & {
    error?: string;
  };
  const value = body[key];

  if (!response.ok || value == null) {
    throw new Error(typeof body.error === "string" ? body.error : fallbackError);
  }

  return value as T;
}
