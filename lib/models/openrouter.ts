/**
 * OpenRouter model catalog helpers, shared by the models list route and the
 * chat route. Both read the account-scoped catalog (the models the account is
 * configured to use — provider + privacy filtered), so the picker offers the
 * same set the chat route validates against.
 *
 * The catalog is memoized in-process with a short TTL rather than relying on
 * Next's fetch data cache: an Authorization-bearing fetch inside a route
 * handler is not reliably cached, so we cache the parsed result here. Both
 * callers go through fetchAccountModels, so within the TTL they share one
 * upstream request and stay consistent with each other.
 */

const MODELS_USER_ENDPOINT = "https://openrouter.ai/api/v1/models/user";
const CATALOG_TTL_MS = 5 * 60 * 1000;

/** Trimmed model shape sent to the client — just what the picker renders. */
export type OpenRouterModelSummary = {
  id: string;
  name: string;
  contextLength: number | null;
};

type RawModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
};

type CacheEntry = { models: OpenRouterModelSummary[]; expires: number };

// Keyed by API key so a future per-user key never serves another account's set.
const catalogCache = new Map<string, CacheEntry>();

function toSummary(raw: RawModel): OpenRouterModelSummary | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }

  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : raw.id;
  const contextLength = typeof raw.context_length === "number" ? raw.context_length : null;

  return { id: raw.id, name, contextLength };
}

async function fetchFromUpstream(apiKey: string): Promise<OpenRouterModelSummary[]> {
  const response = await fetch(MODELS_USER_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter models request failed with status ${response.status}`);
  }

  const body: { data?: unknown } = await response.json();
  const data = Array.isArray(body.data) ? body.data : [];

  return data
    .map((raw) => toSummary(raw as RawModel))
    .filter((model): model is OpenRouterModelSummary => model !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Fetch the account's models, trimmed and sorted by display name. Memoized for
 * CATALOG_TTL_MS; throws on a non-2xx upstream response (a failed fetch is not
 * cached, so the next call retries). Callers decide how to fail soft.
 */
export async function fetchAccountModels(apiKey: string): Promise<OpenRouterModelSummary[]> {
  const cached = catalogCache.get(apiKey);
  if (cached && cached.expires > Date.now()) {
    return cached.models;
  }

  const models = await fetchFromUpstream(apiKey);
  catalogCache.set(apiKey, { models, expires: Date.now() + CATALOG_TTL_MS });
  return models;
}

/**
 * Resolve the model id for a chat turn. A client-supplied model is honored only
 * if it's in the account's catalog; anything missing, malformed, or unknown
 * falls back to the env default. Fails soft: if the catalog can't be fetched,
 * the default is used (never trust the client, never 400 the chat over it).
 */
export async function resolveChatModel({
  requested,
  apiKey,
  fallback,
}: {
  requested: string | null;
  apiKey: string;
  fallback: string;
}): Promise<string> {
  if (!requested || requested === fallback) {
    return fallback;
  }

  try {
    const models = await fetchAccountModels(apiKey);
    return models.some((model) => model.id === requested) ? requested : fallback;
  } catch (error) {
    console.error("Model validation failed; falling back to the default model", error);
    return fallback;
  }
}
