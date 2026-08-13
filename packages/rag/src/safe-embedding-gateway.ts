import { hasNoLeakingPii, redactText } from "@cognia/redact"

import { getProviderLocality, sha256Hex, type RetrievalProfileV1 } from "./retrieval-profile"

export type EmbeddingPurpose = "query" | "document" | "maintenance"

export interface SafeEmbeddingResult {
  embedding: number[]
  provider: RetrievalProfileV1["embedding"]["provider"]
  model: string
  locality: "local" | "remote"
  safeTextHash: string
  redacted: boolean
  cacheHit: boolean
  dimensions: number
}

export interface SafeEmbeddingCache {
  get(key: string): Promise<number[] | undefined> | number[] | undefined
  set(key: string, embedding: number[]): Promise<void> | void
}

export interface SafeEmbeddingGatewayDependencies {
  embed: (
    text: string,
    context: {
      provider: RetrievalProfileV1["embedding"]["provider"]
      model: string
      purpose: EmbeddingPurpose
    }
  ) => Promise<number[]>
  cache?: SafeEmbeddingCache
  redact?: (text: string) => { redacted: string }
  isSafe?: (text: string) => boolean
}

export interface SafeEmbeddingInput {
  profile: RetrievalProfileV1
  text: string
  purpose: EmbeddingPurpose
}

export class EmbeddingSafetyError extends Error {
  readonly code = "embedding_safety_gate_failed"

  constructor(message: string) {
    super(message)
    this.name = "EmbeddingSafetyError"
  }
}

export class EmbeddingValidationError extends Error {
  readonly code = "embedding_validation_failed"

  constructor(message: string) {
    super(message)
    this.name = "EmbeddingValidationError"
  }
}

function validateEmbedding(embedding: number[], expectedDimensions?: number): void {
  if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
    throw new EmbeddingValidationError("Embedding must contain finite numeric values")
  }
  if (expectedDimensions !== undefined && embedding.length !== expectedDimensions) {
    throw new EmbeddingValidationError(
      `Embedding dimension mismatch: expected ${expectedDimensions}, received ${embedding.length}`
    )
  }
}

export function createSafeEmbeddingGateway(dependencies: SafeEmbeddingGatewayDependencies) {
  return {
    async embed(input: SafeEmbeddingInput): Promise<SafeEmbeddingResult> {
      const { profile } = input
      const locality = getProviderLocality(profile.embedding.provider)
      if (!input.text.trim()) {
        throw new EmbeddingValidationError("Embedding text must not be empty")
      }

      const useOriginalText = locality === "local" && profile.safety.localOriginalText === "allow"
      const redaction = useOriginalText
        ? { redacted: input.text }
        : (dependencies.redact ?? redactText)(input.text)
      const safeText = redaction.redacted

      if (!useOriginalText && !(dependencies.isSafe ?? hasNoLeakingPii)(safeText)) {
        throw new EmbeddingSafetyError("PII redaction could not guarantee a safe embedding payload")
      }
      if (!safeText.trim()) {
        throw new EmbeddingSafetyError("PII redaction produced an empty embedding payload")
      }

      const safeTextHash = await sha256Hex(safeText)
      const cacheKey = `${profile.embedding.provider}:${profile.embedding.model}:${safeTextHash}`
      const cached = await dependencies.cache?.get(cacheKey)
      if (cached) {
        validateEmbedding(cached, profile.embedding.dimensions)
        return {
          embedding: [...cached],
          provider: profile.embedding.provider,
          model: profile.embedding.model,
          locality,
          safeTextHash,
          redacted: safeText !== input.text,
          cacheHit: true,
          dimensions: cached.length,
        }
      }

      const embedding = await dependencies.embed(safeText, {
        provider: profile.embedding.provider,
        model: profile.embedding.model,
        purpose: input.purpose,
      })
      validateEmbedding(embedding, profile.embedding.dimensions)
      await dependencies.cache?.set(cacheKey, [...embedding])

      return {
        embedding: [...embedding],
        provider: profile.embedding.provider,
        model: profile.embedding.model,
        locality,
        safeTextHash,
        redacted: safeText !== input.text,
        cacheHit: false,
        dimensions: embedding.length,
      }
    },
  }
}
