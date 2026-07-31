import { getBuiltInProviderCatalog } from "@cognia/provider-types/built-in-provider-catalog"

import { InMemoryCatalogRepository } from "./catalog-repository"
import { buildCatalogSnapshotFromModelsDev } from "./models-dev"

export const CERTIFICATION_CANDIDATES = [
  { id: "openai", providerIds: ["openai"] },
  { id: "anthropic", providerIds: ["anthropic"] },
  { id: "google-gemini", providerIds: ["google"] },
  { id: "xai", providerIds: ["xai"] },
  { id: "mistral", providerIds: ["mistral"] },
  { id: "deepseek", providerIds: ["deepseek"] },
  { id: "groq", providerIds: ["groq"] },
  { id: "openrouter", providerIds: ["openrouter"] },
  { id: "vercel-ai-gateway", providerIds: ["models-dev:vercel"] },
  { id: "aws-bedrock", providerIds: ["bedrock"] },
  { id: "azure-openai", providerIds: ["azure"] },
  { id: "google-vertex-ai", providerIds: ["models-dev:google-vertex"] },
  { id: "alibaba-qwen-bailian", providerIds: ["qwen", "bailian-anthropic"] },
  { id: "zhipu-glm-zai", providerIds: ["zhipu", "glm4"] },
  { id: "moonshot-kimi", providerIds: ["moonshot", "kimi-anthropic"] },
  { id: "minimax", providerIds: ["minimax"] },
  { id: "volcengine-doubao", providerIds: ["volcengine", "doubao"] },
  { id: "siliconflow", providerIds: ["siliconflow"] },
  { id: "modelscope", providerIds: ["modelscope"] },
  { id: "nvidia-nim", providerIds: ["nvidia"] },
  { id: "hugging-face-inference", providerIds: ["huggingface"] },
  { id: "ollama", providerIds: ["ollama"] },
  { id: "lm-studio", providerIds: ["lmstudio"] },
  { id: "vllm", providerIds: ["vllm"] },
] as const

/** Providers that have passed the bundled conformance baseline today. */
export const BUNDLED_CERTIFIED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "openrouter",
  "bedrock",
  "ollama",
])

let bundledRepository: InMemoryCatalogRepository | undefined

/**
 * Offline last-known-good catalog for headless consumers before live storage
 * is available. It is built through the same mapper and repository as the
 * reviewed remote revision, never through a private model table.
 */
export function getBundledCatalogRepository(): InMemoryCatalogRepository {
  bundledRepository ??= new InMemoryCatalogRepository(
    buildCatalogSnapshotFromModelsDev(
      {},
      {
        revisionId: "bundled-catalog-v1",
        generatedAt: "2026-07-31T00:00:00.000Z",
        checksum: "bundled:built-in-provider-catalog",
        builtInCatalog: getBuiltInProviderCatalog(),
        certifiedProviderIds: BUNDLED_CERTIFIED_PROVIDER_IDS,
        includeExperimentalProviders: false,
      }
    )
  )
  return bundledRepository
}
