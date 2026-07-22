/**
 * Canonical RAG embedding-provider catalog — single source of truth for the
 * providers the Twin / vector pipeline can select.
 *
 * Before this module the selectable provider union was redeclared in three
 * places (`lib/vector/embedding.ts`, `types/twin/index.ts`,
 * `stores/vector/vector-store.ts`) and they drifted: local engines and Ollama
 * were reachable one layer down but never exposed, and azure/bedrock/voyage
 * were type-declared without a resolver branch (a latent crash). This catalog
 * fixes the drift — every selector, the adapter, the resolver, and the
 * dimension guard read the SAME list.
 *
 * Azure remains excluded until its deployment/resource configuration is wired.
 * Amazon Bedrock is native and supports API-key, explicit IAM, and sidecar
 * default-chain authentication.
 */

import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "./local-embedding"
import { embeddingDimensions } from "./embedding"

/**
 * Ordered list of embedding providers the RAG / Twin pipeline can select.
 * Order is the display order in the settings select.
 */
export const RAG_EMBEDDING_PROVIDERS = [
  "openai",
  "google",
  "cohere",
  "mistral",
  "voyage",
  "amazon-bedrock",
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
  "localai",
  "jan",
  "transformersjs",
] as const

export type RagEmbeddingProvider = (typeof RAG_EMBEDDING_PROVIDERS)[number]

/**
 * How a provider runs — drives credential/baseURL UI affordances and the
 * resolver branch in `lib/ai/embedding/embedding.ts`.
 *   - cloud:        hosted API, needs an API key (openai/google/cohere/mistral/voyage)
 *   - native-local: Ollama native `/api/embeddings` (no key, needs baseURL)
 *   - local-openai: OpenAI-compatible `/v1/embeddings` engine (no key, needs baseURL)
 *   - browser:      in-process transformers.js (no key, no baseURL)
 */
export type EmbeddingProviderKind =
  "cloud" | "bedrock" | "native-local" | "local-openai" | "browser"

export interface EmbeddingProviderDescriptor {
  id: RagEmbeddingProvider
  kind: EmbeddingProviderKind
  /** Default model when the user hasn't pinned one. */
  defaultModel: string
  /** Known output dimension for the default model, when fixed. */
  defaultDimensions?: number
  /** Whether a cloud API key is required to use the provider. */
  requiresApiKey: boolean
  /** Whether the settings UI should surface a base-URL input. */
  requiresBaseURL: boolean
}

const CATALOG: Record<RagEmbeddingProvider, EmbeddingProviderDescriptor> = {
  openai: {
    id: "openai",
    kind: "cloud",
    defaultModel: "text-embedding-3-small",
    defaultDimensions: 1536,
    requiresApiKey: true,
    requiresBaseURL: false,
  },
  google: {
    id: "google",
    kind: "cloud",
    defaultModel: "text-embedding-004",
    defaultDimensions: 768,
    requiresApiKey: true,
    requiresBaseURL: false,
  },
  cohere: {
    id: "cohere",
    kind: "cloud",
    defaultModel: "embed-english-v3.0",
    defaultDimensions: 1024,
    requiresApiKey: true,
    requiresBaseURL: false,
  },
  mistral: {
    id: "mistral",
    kind: "cloud",
    defaultModel: "mistral-embed",
    defaultDimensions: 1024,
    requiresApiKey: true,
    requiresBaseURL: false,
  },
  voyage: {
    id: "voyage",
    kind: "cloud",
    defaultModel: "voyage-3",
    defaultDimensions: 1024,
    requiresApiKey: true,
    // Fixed endpoint by default, but allow pointing at a proxy.
    requiresBaseURL: true,
  },
  "amazon-bedrock": {
    id: "amazon-bedrock",
    kind: "bedrock",
    defaultModel: "amazon.titan-embed-text-v2:0",
    defaultDimensions: 1024,
    requiresApiKey: false,
    requiresBaseURL: false,
  },
  ollama: {
    id: "ollama",
    kind: "native-local",
    defaultModel: "nomic-embed-text",
    defaultDimensions: 768,
    requiresApiKey: false,
    requiresBaseURL: true,
  },
  lmstudio: {
    id: "lmstudio",
    kind: "local-openai",
    defaultModel: DEFAULT_LOCAL_EMBEDDING_MODEL,
    requiresApiKey: false,
    requiresBaseURL: true,
  },
  llamacpp: {
    id: "llamacpp",
    kind: "local-openai",
    defaultModel: DEFAULT_LOCAL_EMBEDDING_MODEL,
    requiresApiKey: false,
    requiresBaseURL: true,
  },
  vllm: {
    id: "vllm",
    kind: "local-openai",
    defaultModel: DEFAULT_LOCAL_EMBEDDING_MODEL,
    requiresApiKey: false,
    requiresBaseURL: true,
  },
  localai: {
    id: "localai",
    kind: "local-openai",
    defaultModel: DEFAULT_LOCAL_EMBEDDING_MODEL,
    requiresApiKey: false,
    requiresBaseURL: true,
  },
  jan: {
    id: "jan",
    kind: "local-openai",
    defaultModel: DEFAULT_LOCAL_EMBEDDING_MODEL,
    requiresApiKey: false,
    requiresBaseURL: true,
  },
  transformersjs: {
    id: "transformersjs",
    kind: "browser",
    defaultModel: "Xenova/all-MiniLM-L6-v2",
    defaultDimensions: 384,
    requiresApiKey: false,
    requiresBaseURL: false,
  },
}

export function isRagEmbeddingProvider(value: string): value is RagEmbeddingProvider {
  return Object.prototype.hasOwnProperty.call(CATALOG, value)
}

export function getEmbeddingProviderDescriptor(
  provider: RagEmbeddingProvider
): EmbeddingProviderDescriptor {
  return CATALOG[provider]
}

export function embeddingProviderRequiresBaseURL(provider: RagEmbeddingProvider): boolean {
  return CATALOG[provider].requiresBaseURL
}

export function embeddingProviderRequiresApiKey(provider: RagEmbeddingProvider): boolean {
  return CATALOG[provider].requiresApiKey
}

/**
 * Best-effort expected output dimension for a provider/model pair. Returns
 * `undefined` when the model is unknown (local engines, custom models) so
 * callers fall back to the actual generated vector length.
 */
export function expectedEmbeddingDimension(
  provider: RagEmbeddingProvider,
  model?: string
): number | undefined {
  if (model && embeddingDimensions[model] !== undefined) {
    return embeddingDimensions[model]
  }
  const descriptor = CATALOG[provider]
  if (!model || model === descriptor.defaultModel) {
    return descriptor.defaultDimensions
  }
  return undefined
}
