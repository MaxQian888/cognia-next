import {
  getEmbeddingProviderDescriptor,
  type RagEmbeddingProvider,
} from "@cognia/provider-embedding/embedding-catalog"

export const RETRIEVAL_PROFILE_SCHEMA_VERSION = 1 as const

export type ProviderLocality = "local" | "remote"
export type RetrievalVectorBackend =
  | "memory"
  | "native"
  | "indexeddb"
  | "sqlite"
  | "lancedb"
  | "chroma"
  | "pinecone"
  | "weaviate"
  | "qdrant"

export interface RetrievalProfileV1 {
  schemaVersion: typeof RETRIEVAL_PROFILE_SCHEMA_VERSION
  id: string
  embedding: {
    provider: RagEmbeddingProvider
    model: string
    dimensions?: number
  }
  vector: {
    backend: RetrievalVectorBackend
    collectionPolicy: "generation"
  }
  budgets: {
    topK: number
    tokenBudget: number
    timeoutMs: number
  }
  retrieval: {
    expansion: "disabled" | "local" | "provider"
    rerank: "disabled" | "local" | "provider"
  }
  safety: {
    cloudText: "redact-fail-closed"
    localOriginalText: "allow" | "redact"
    retrievedContent: "data-only"
  }
}

export interface CreateRetrievalProfileInput {
  id: string
  embedding: RetrievalProfileV1["embedding"]
  vector?: Partial<RetrievalProfileV1["vector"]>
  budgets?: Partial<RetrievalProfileV1["budgets"]>
  retrieval?: Partial<RetrievalProfileV1["retrieval"]>
  safety?: Partial<RetrievalProfileV1["safety"]>
}

const DEFAULT_BUDGETS: RetrievalProfileV1["budgets"] = {
  topK: 8,
  tokenBudget: 900,
  timeoutMs: 700,
}

const DEFAULT_RETRIEVAL: RetrievalProfileV1["retrieval"] = {
  expansion: "disabled",
  rerank: "disabled",
}

const DEFAULT_SAFETY: RetrievalProfileV1["safety"] = {
  cloudText: "redact-fail-closed",
  localOriginalText: "redact",
  retrievedContent: "data-only",
}

export function isLocalEmbeddingProvider(provider: RagEmbeddingProvider): boolean {
  const kind = getEmbeddingProviderDescriptor(provider)?.kind
  return kind === "native-local" || kind === "local-openai" || kind === "browser"
}

export function getProviderLocality(provider: RagEmbeddingProvider): ProviderLocality {
  return isLocalEmbeddingProvider(provider) ? "local" : "remote"
}

export function createRetrievalProfile(input: CreateRetrievalProfileInput): RetrievalProfileV1 {
  if (!input.id.trim()) {
    throw new Error("Retrieval profile id is required")
  }
  if (!input.embedding.model.trim()) {
    throw new Error("Embedding model is required")
  }

  return {
    schemaVersion: RETRIEVAL_PROFILE_SCHEMA_VERSION,
    id: input.id,
    embedding: { ...input.embedding },
    vector: {
      backend: input.vector?.backend ?? "memory",
      collectionPolicy: "generation",
    },
    budgets: {
      ...DEFAULT_BUDGETS,
      ...input.budgets,
    },
    retrieval: {
      ...DEFAULT_RETRIEVAL,
      ...input.retrieval,
    },
    safety: {
      ...DEFAULT_SAFETY,
      ...input.safety,
    },
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function fingerprintRetrievalProfile(profile: RetrievalProfileV1): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize(profile)))
}
