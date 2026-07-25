/**
 * Authoritative mapping between our internal provider ids and the provider ids
 * used by the models.dev catalog (https://models.dev/api.json).
 *
 * Most of our built-in provider ids match models.dev verbatim; this table only
 * records the *differences* (verified against the bundled snapshot). Providers
 * with no models.dev entry (e.g. local-only `ollama`, `vllm`, or vendors
 * models.dev doesn't track like `sambanova`, `baichuan`) simply resolve to
 * `undefined` from {@link resolveModelsDevProviderId} — the catalog layer then
 * yields no remote models for them, which is the correct degradation.
 *
 * This is the single source of truth for the our-id ↔ models.dev-id relation;
 * `lib/ai/icons.ts` derives its icon CDN map from {@link MODELS_DEV_PROVIDER_ID_MAP}.
 */

import { BUILT_IN_PROVIDER_IDS } from "@cognia/provider-types/built-in-provider-catalog"

/**
 * our-id → models.dev-id, only where they differ from identity. Verified
 * against the bundled snapshot's top-level provider keys.
 */
export const MODELS_DEV_PROVIDER_ID_MAP: Record<string, string> = {
  fireworks: "fireworks-ai",
  moonshot: "moonshotai",
  novita: "novita-ai",
  zhipu: "zhipuai",
  glm4: "zhipuai",
  qwen: "alibaba",
  bedrock: "amazon-bedrock",
  cloudflare: "cloudflare-workers-ai",
  github: "github-models",
}

/** Built-in provider ids that have a known models.dev catalog entry (identity). */
const MODELS_DEV_IDENTITY_PROVIDERS = new Set<string>([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "groq",
  "mistral",
  "xai",
  "togetherai",
  "openrouter",
  "cohere",
  "cerebras",
  "siliconflow",
  "stepfun",
  "perplexity",
  "deepinfra",
  "minimax",
  "lmstudio",
  "azure",
  "nvidia",
  "huggingface",
  "modelscope",
  "opencode",
  "opencode-go",
])

/**
 * Resolve our provider id to the models.dev catalog id. Returns `undefined`
 * when models.dev has no entry for this provider (local providers, untracked
 * vendors) — callers treat that as "no remote models available".
 */
export function resolveModelsDevProviderId(providerId: string): string | undefined {
  const normalized = providerId.toLowerCase()
  if (MODELS_DEV_PROVIDER_ID_MAP[normalized]) return MODELS_DEV_PROVIDER_ID_MAP[normalized]
  if (MODELS_DEV_IDENTITY_PROVIDERS.has(normalized)) return normalized
  return undefined
}

/** Reverse lookup: models.dev id → our built-in provider id (first match). */
export function resolveOurProviderId(modelsDevId: string): string | undefined {
  const normalized = modelsDevId.toLowerCase()
  for (const [ourId, devId] of Object.entries(MODELS_DEV_PROVIDER_ID_MAP)) {
    if (devId === normalized) return ourId
  }
  if (MODELS_DEV_IDENTITY_PROVIDERS.has(normalized)) return normalized
  return undefined
}

/** Our built-in provider ids that map to a models.dev catalog entry. */
export function builtInProvidersWithModelsDevEntry(): string[] {
  return BUILT_IN_PROVIDER_IDS.filter((id) => resolveModelsDevProviderId(id) !== undefined)
}
