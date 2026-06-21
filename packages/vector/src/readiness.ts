import { isTauri } from "@/lib/utils"
import { updateStorageBackendReadiness } from "@/lib/storage/persistence/backend-readiness"
import {
  createStorageBackendDiagnostic,
  type StorageBackendVerificationOptions,
  type StorageBackendVerifier,
} from "@/lib/storage/persistence/backend-verifier"
import type {
  StorageBackendId,
  StorageBackendReadinessRecord,
  StorageBackendReadinessState,
} from "@/lib/storage/persistence/types"
import { createVectorStore, type VectorStoreConfig, type VectorStoreProvider } from "./store"

const VECTOR_BACKEND_ID: Record<VectorStoreProvider, StorageBackendId> = {
  native: "vector-native",
  chroma: "vector-chroma",
  pinecone: "vector-pinecone",
  weaviate: "vector-weaviate",
  qdrant: "vector-qdrant",
  milvus: "vector-milvus",
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildProbeName(provider: VectorStoreProvider): string {
  return `cognia-readiness-${provider}-${Date.now()}`
}

function classifyVectorError(
  message: string,
  stage: "configuration" | "reachability" | "operational" | "cleanup"
): {
  code: string
  state: StorageBackendReadinessState
} {
  if (stage === "configuration") {
    return { code: "configuration-missing", state: "unconfigured" }
  }

  const normalized = message.toLowerCase()

  if (stage === "cleanup") {
    return { code: "cleanup-failed", state: "degraded" }
  }

  if (
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("invalid api key") ||
    normalized.includes("invalid token")
  ) {
    return { code: "auth-failed", state: "configured" }
  }

  if (
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("network") ||
    normalized.includes("fetch failed") ||
    normalized.includes("timeout") ||
    normalized.includes("socket")
  ) {
    return { code: "network-failed", state: "configured" }
  }

  if (
    normalized.includes("collection") ||
    normalized.includes("namespace") ||
    normalized.includes("class") ||
    normalized.includes("index") ||
    normalized.includes("missing") ||
    normalized.includes("required")
  ) {
    return {
      code: stage === "reachability" ? "prerequisite-missing" : "prerequisite-missing",
      state: stage === "operational" ? "reachable" : "configured",
    }
  }

  return {
    code: stage === "operational" ? "roundtrip-failed" : "reachability-failed",
    state: stage === "operational" ? "reachable" : "configured",
  }
}

function validateVectorConfig(config: VectorStoreConfig): string | null {
  if (config.provider === "native") {
    if (!isTauri()) {
      return "Native vector store requires Tauri runtime"
    }
    return null
  }
  // All cloud providers post-ADR-0022 require a configId pointing at a
  // keyring-stored credential. Per-provider URL/key/etc. validation moved
  // into the Rust resolver layer.
  if (!config.configId?.trim()) {
    return `${config.provider} provider requires configId (configure credentials first)`
  }
  return null
}

function finalizeVectorReadiness(
  backendId: StorageBackendId,
  state: StorageBackendReadinessState,
  checkedAt: string,
  diagnostic?: StorageBackendReadinessRecord["diagnostic"]
): StorageBackendReadinessRecord {
  const record = updateStorageBackendReadiness({
    id: backendId,
    state,
    lastCheckedAt: checkedAt,
    diagnostic,
    metadata: {
      source: "vector-verifier",
    },
  })

  return record
}

class VectorBackendReadinessVerifier implements StorageBackendVerifier<VectorStoreConfig> {
  readonly backendId: StorageBackendId

  constructor(private readonly provider: VectorStoreProvider) {
    this.backendId = VECTOR_BACKEND_ID[provider]
  }

  async verifyReadiness(
    config: VectorStoreConfig,
    options: StorageBackendVerificationOptions = {}
  ): Promise<StorageBackendReadinessRecord> {
    const checkedAt = options.checkedAt || nowIso()
    const configurationError = validateVectorConfig(config)
    if (configurationError) {
      const classification = classifyVectorError(configurationError, "configuration")
      return finalizeVectorReadiness(
        this.backendId,
        classification.state,
        checkedAt,
        createStorageBackendDiagnostic(
          classification.code,
          configurationError,
          checkedAt,
          { provider: this.provider },
          "configuration"
        )
      )
    }

    try {
      const store = createVectorStore(config)
      await store.listCollections()

      if (options.probeOperational === false) {
        return finalizeVectorReadiness(this.backendId, "reachable", checkedAt)
      }

      const probeName = buildProbeName(this.provider)
      await store.createCollection(probeName, {
        description: "Readiness verification probe",
        embeddingModel: config.embeddingConfig.model,
        embeddingProvider: config.embeddingConfig.provider,
      })

      try {
        await store.deleteCollection(probeName)
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        const classification = classifyVectorError(message, "cleanup")
        return finalizeVectorReadiness(
          this.backendId,
          classification.state,
          checkedAt,
          createStorageBackendDiagnostic(
            classification.code,
            message,
            checkedAt,
            { provider: this.provider, probeName },
            "operational"
          )
        )
      }

      return finalizeVectorReadiness(this.backendId, "operational", checkedAt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stage = /create|insert|upsert|collection/i.test(message)
        ? "operational"
        : "reachability"
      const classification = classifyVectorError(message, stage)
      return finalizeVectorReadiness(
        this.backendId,
        classification.state,
        checkedAt,
        createStorageBackendDiagnostic(
          classification.code,
          message,
          checkedAt,
          { provider: this.provider },
          stage === "operational" ? "operational" : "reachability"
        )
      )
    }
  }
}

export async function verifyVectorBackendReadiness(
  config: VectorStoreConfig,
  options?: StorageBackendVerificationOptions
): Promise<StorageBackendReadinessRecord> {
  const verifier = new VectorBackendReadinessVerifier(config.provider)
  return verifier.verifyReadiness(config, options)
}
