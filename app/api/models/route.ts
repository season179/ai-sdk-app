import { fetchAccountModels } from "@/lib/models/openrouter";

/**
 * Lists the OpenRouter models this account can call, for the composer's model
 * picker. Proxies the account-scoped catalog server-side so the secret key
 * never reaches the browser. Fails soft: on a missing key or upstream error it
 * returns an empty list plus the env default, so the picker can still offer the
 * default model and chat keeps working.
 */
export async function GET() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const defaultModel = process.env.OPENROUTER_DEFAULT_MODEL?.trim() || null;

  if (!apiKey) {
    return Response.json({ models: [], defaultModel });
  }

  try {
    const models = await fetchAccountModels(apiKey);
    return Response.json({ models, defaultModel });
  } catch (error) {
    console.error("Listing OpenRouter models failed", error);
    return Response.json({ models: [], defaultModel });
  }
}
