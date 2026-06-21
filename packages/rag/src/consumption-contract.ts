import type { RAGRuntimeConfig } from "./rag-runtime"

export type RAGDegradeReason =
  | "none"
  | "not_configured"
  | "no_collection"
  | "collection_unavailable"
  | "empty_results"
  | "quality_filtered"
  | "runtime_error"

export type RAGRetrievalOutcome = "success" | "empty" | "quality_filtered" | "degraded"

export type RAGCollectionSource =
  | "explicit"
  | "scene-default"
  | "runtime-default"
  | "fallback-default"

export type RAGCollectionResolutionStatus = "resolved" | "empty" | "unavailable"

export interface RAGSearchMetadata {
  hybridSearchUsed: boolean
  queryExpansionUsed: boolean
  rerankingUsed: boolean
  originalResultCount: number
  finalResultCount: number
  cacheHit?: boolean
}

export interface ResolveRAGCollectionInput {
  explicitCollectionName?: string
  sceneDefaultCollectionName?: string
  runtimeDefaultCollectionName?: string
  fallbackCollectionName?: string
  allowFallbackDefault?: boolean
  availableCollections?: string[]
}

export interface RAGCollectionResolution {
  status: RAGCollectionResolutionStatus
  collectionName?: string
  source?: RAGCollectionSource
  degradeReason: RAGDegradeReason
}

export interface NormalizedRAGDocument {
  id?: string
  content: string
  similarity: number
  metadata?: Record<string, unknown>
}

export interface NormalizeRAGRetrievalInput {
  query: string
  collectionName?: string
  method?: "pipeline" | "keyword" | "none"
  threshold?: number
  qualityFilteredCount?: number
  collectionStatus?: RAGCollectionResolutionStatus
  collectionDegradeReason?: RAGDegradeReason
  documents: Array<{
    id?: string
    content: string
    rerankScore: number
    metadata?: Record<string, unknown>
  }>
  formattedContext: string
  searchMetadata?: Partial<RAGSearchMetadata>
  error?: unknown
}

export interface NormalizedRAGRetrievalResult {
  success: boolean
  query: string
  results: NormalizedRAGDocument[]
  context: string
  totalResults: number
  searchMetadata: RAGSearchMetadata
  outcome: RAGRetrievalOutcome
  degradeReason: RAGDegradeReason
  diagnostics: {
    resolvedCollection?: string
    collectionStatus: RAGCollectionResolutionStatus
    method: "pipeline" | "keyword" | "none"
    threshold?: number
    qualityFilteredCount: number
  }
  error?: string
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

export function createEmptyRAGSearchMetadata(
  partial: Partial<RAGSearchMetadata> = {}
): RAGSearchMetadata {
  return {
    hybridSearchUsed: false,
    queryExpansionUsed: false,
    rerankingUsed: false,
    originalResultCount: 0,
    finalResultCount: 0,
    ...partial,
  }
}

export function composeRAGRuntimeConfig(
  baseConfig: RAGRuntimeConfig,
  overrides: Partial<RAGRuntimeConfig> = {}
): RAGRuntimeConfig {
  return {
    ...baseConfig,
    ...overrides,
    vectorStore: {
      ...baseConfig.vectorStore,
      ...overrides.vectorStore,
    },
  }
}

export function resolveRAGCollection(input: ResolveRAGCollectionInput): RAGCollectionResolution {
  const allowFallbackDefault = input.allowFallbackDefault ?? true
  const fallbackCollectionName = firstNonEmpty(input.fallbackCollectionName) ?? "default"

  const explicit = firstNonEmpty(input.explicitCollectionName)
  const sceneDefault = firstNonEmpty(input.sceneDefaultCollectionName)
  const runtimeDefault = firstNonEmpty(input.runtimeDefaultCollectionName)

  const resolvedCollection = firstNonEmpty(
    explicit,
    sceneDefault,
    runtimeDefault,
    allowFallbackDefault ? fallbackCollectionName : undefined
  )

  if (!resolvedCollection) {
    return {
      status: "empty",
      degradeReason: "no_collection",
    }
  }

  const source: RAGCollectionSource = explicit
    ? "explicit"
    : sceneDefault
      ? "scene-default"
      : runtimeDefault
        ? "runtime-default"
        : "fallback-default"

  if (
    input.availableCollections &&
    input.availableCollections.length > 0 &&
    !input.availableCollections.includes(resolvedCollection)
  ) {
    return {
      status: "unavailable",
      collectionName: resolvedCollection,
      source,
      degradeReason: "collection_unavailable",
    }
  }

  return {
    status: "resolved",
    collectionName: resolvedCollection,
    source,
    degradeReason: "none",
  }
}

export function normalizeRAGRetrievalResult(
  input: NormalizeRAGRetrievalInput
): NormalizedRAGRetrievalResult {
  const mappedResults: NormalizedRAGDocument[] = input.documents.map((document) => ({
    id: document.id,
    content: document.content,
    similarity: document.rerankScore,
    metadata: document.metadata,
  }))
  const qualityFilteredCount = input.qualityFilteredCount ?? 0
  const metadata = createEmptyRAGSearchMetadata(input.searchMetadata)
  const collectionStatus = input.collectionStatus ?? (input.collectionName ? "resolved" : "empty")
  const method = input.method ?? "pipeline"

  const runtimeError =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === "string"
        ? input.error
        : undefined

  let outcome: RAGRetrievalOutcome = "success"
  let degradeReason: RAGDegradeReason = input.collectionDegradeReason ?? "none"
  let success = true

  if (runtimeError) {
    outcome = "degraded"
    degradeReason = "runtime_error"
    success = false
  } else if (collectionStatus !== "resolved") {
    outcome = "degraded"
    degradeReason = input.collectionDegradeReason ?? "no_collection"
    success = false
  } else if (mappedResults.length === 0 && qualityFilteredCount > 0) {
    outcome = "quality_filtered"
    degradeReason = "quality_filtered"
  } else if (mappedResults.length === 0) {
    outcome = "empty"
    degradeReason = "empty_results"
  }

  return {
    success,
    query: input.query,
    results: mappedResults,
    context: input.formattedContext,
    totalResults: mappedResults.length,
    searchMetadata: metadata,
    outcome,
    degradeReason,
    diagnostics: {
      resolvedCollection: input.collectionName,
      collectionStatus,
      method,
      threshold: input.threshold,
      qualityFilteredCount,
    },
    ...(runtimeError ? { error: runtimeError } : {}),
  }
}
