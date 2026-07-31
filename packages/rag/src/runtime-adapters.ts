export type StorageBackendId =
  | "web-dexie"
  | "vector-native"
  | "vector-chroma"
  | "vector-pinecone"
  | "vector-weaviate"
  | "vector-qdrant"
  | "vector-milvus"
  | (string & {})

export type StorageBackendCategory = "browser-persistence" | "vector-provider" | "knowledge-store"

export type StorageBackendReadinessState =
  "unconfigured" | "configured" | "reachable" | "operational" | "degraded"

export interface StorageBackendDiagnostic {
  code: string
  message: string
  at: string
  details?: Record<string, unknown>
  stage?: "configuration" | "reachability" | "operational" | "cleanup"
}

export interface StorageBackendReadinessRecord {
  id: StorageBackendId
  label: string
  category: StorageBackendCategory
  state: StorageBackendReadinessState
  lastCheckedAt?: string
  diagnostic?: StorageBackendDiagnostic
  metadata?: Record<string, unknown>
}

export interface StorageBackendReadinessUpdate {
  id: StorageBackendId
  label?: string
  category?: StorageBackendCategory
  state: StorageBackendReadinessState
  lastCheckedAt?: string
  diagnostic?: StorageBackendDiagnostic
  metadata?: Record<string, unknown>
}

export interface ModelContextLimits {
  maxTokens: number
  reserveTokens: number
}

export interface RAGLogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void
}

export type RAGProxyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface RAGRuntimeAdapters {
  logger?: Partial<RAGLogger>
  proxyFetch?: RAGProxyFetch
}

const MODEL_CONTEXT_LIMITS: Record<string, ModelContextLimits> = {
  "gpt-4": { maxTokens: 8192, reserveTokens: 2000 },
  "gpt-4-32k": { maxTokens: 32768, reserveTokens: 4000 },
  "gpt-4-turbo": { maxTokens: 128000, reserveTokens: 8000 },
  "gpt-4o": { maxTokens: 128000, reserveTokens: 8000 },
  "gpt-4o-mini": { maxTokens: 128000, reserveTokens: 8000 },
  "gpt-5.4": { maxTokens: 1000000, reserveTokens: 10000 },
  "gpt-5.4-mini": { maxTokens: 1000000, reserveTokens: 10000 },
  "gpt-5.4-nano": { maxTokens: 1000000, reserveTokens: 8000 },
  "gpt-5.4-pro": { maxTokens: 1000000, reserveTokens: 10000 },
  "gpt-4.1": { maxTokens: 1047576, reserveTokens: 10000 },
  "gpt-4.1-mini": { maxTokens: 1047576, reserveTokens: 10000 },
  "gpt-4.1-nano": { maxTokens: 1047576, reserveTokens: 8000 },
  "gpt-3.5-turbo": { maxTokens: 16385, reserveTokens: 2000 },
  o1: { maxTokens: 200000, reserveTokens: 10000 },
  o3: { maxTokens: 200000, reserveTokens: 10000 },
  "o4-mini": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3-opus": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3-haiku": { maxTokens: 200000, reserveTokens: 8000 },
  "claude-3.5-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-3.5-haiku": { maxTokens: 200000, reserveTokens: 8000 },
  "claude-4-opus": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-4-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "claude-sonnet": { maxTokens: 200000, reserveTokens: 10000 },
  "gemini-pro": { maxTokens: 32768, reserveTokens: 4000 },
  "gemini-1.5-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-1.5-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.0-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-3-flash-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-3.1-pro-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-3.1-flash-lite-preview": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.5-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.5-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "gemini-2.5-flash-lite": { maxTokens: 1048576, reserveTokens: 8000 },
  "deepseek-v4-flash": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-v4-pro": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-v3": { maxTokens: 128000, reserveTokens: 8000 },
  "deepseek-r1": { maxTokens: 128000, reserveTokens: 8000 },
  "deepseek-chat": { maxTokens: 1048576, reserveTokens: 10000 },
  "deepseek-reasoner": { maxTokens: 1048576, reserveTokens: 10000 },
  "qwen-2.5": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-3": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-turbo": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-plus": { maxTokens: 131072, reserveTokens: 8000 },
  "qwen-max": { maxTokens: 131072, reserveTokens: 8000 },
}

const DEFAULT_LABELS: Record<StorageBackendId, string> = {
  "web-dexie": "Browser (Dexie/IndexedDB)",
  "vector-native": "Vector (native)",
  "vector-chroma": "Chroma",
  "vector-pinecone": "Pinecone",
  "vector-weaviate": "Weaviate",
  "vector-qdrant": "Qdrant",
  "vector-milvus": "Milvus",
}

const readinessRegistry = new Map<StorageBackendId, StorageBackendReadinessRecord>()

const noopLogger: RAGLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let adapters: Required<Pick<RAGRuntimeAdapters, "proxyFetch">> &
  Pick<RAGRuntimeAdapters, "logger"> = {
  proxyFetch: (input, init) => fetch(input, init),
  logger: {},
}

function categoryFor(id: StorageBackendId): StorageBackendCategory {
  return id === "web-dexie" ? "browser-persistence" : "vector-provider"
}

export function setRAGRuntimeAdapters(next: RAGRuntimeAdapters): void {
  adapters = {
    proxyFetch: next.proxyFetch ?? adapters.proxyFetch,
    logger: {
      ...adapters.logger,
      ...next.logger,
    },
  }
}

export function resetRAGRuntimeAdaptersForTesting(): void {
  adapters = {
    proxyFetch: (input, init) => fetch(input, init),
    logger: {},
  }
  readinessRegistry.clear()
}

export function getRAGLogger(): RAGLogger {
  return {
    debug(message, data) {
      ;(adapters.logger?.debug ?? noopLogger.debug)(message, data)
    },
    info(message, data) {
      ;(adapters.logger?.info ?? noopLogger.info)(message, data)
    },
    warn(message, data) {
      ;(adapters.logger?.warn ?? noopLogger.warn)(message, data)
    },
    error(message, error, data) {
      ;(adapters.logger?.error ?? noopLogger.error)(message, error, data)
    },
  }
}

export function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return adapters.proxyFetch(input, init)
}

export function updateStorageBackendReadiness(
  update: StorageBackendReadinessUpdate
): StorageBackendReadinessRecord {
  const existing = readinessRegistry.get(update.id)
  const record: StorageBackendReadinessRecord = {
    id: update.id,
    label: update.label ?? existing?.label ?? DEFAULT_LABELS[update.id] ?? update.id,
    category: update.category ?? existing?.category ?? categoryFor(update.id),
    state: update.state,
    lastCheckedAt: update.lastCheckedAt ?? new Date().toISOString(),
    diagnostic: update.diagnostic ?? existing?.diagnostic,
    metadata: update.metadata ?? existing?.metadata,
  }
  readinessRegistry.set(update.id, record)
  return record
}

export function getStorageBackendReadiness(
  id: StorageBackendId
): StorageBackendReadinessRecord | undefined {
  return readinessRegistry.get(id)
}

export function resetStorageBackendReadinessRegistryForTest(): void {
  readinessRegistry.clear()
}

export function getModelContextLimits(model: string): ModelContextLimits {
  if (MODEL_CONTEXT_LIMITS[model]) {
    return MODEL_CONTEXT_LIMITS[model]
  }

  const sortedKeys = Object.keys(MODEL_CONTEXT_LIMITS).sort((a, b) => b.length - a.length)
  const modelLower = model.toLowerCase()
  for (const key of sortedKeys) {
    if (modelLower.includes(key)) {
      return MODEL_CONTEXT_LIMITS[key]
    }
  }

  if (modelLower.includes("claude")) return { maxTokens: 200000, reserveTokens: 10000 }
  if (modelLower.includes("gemini")) return { maxTokens: 1048576, reserveTokens: 10000 }
  if (modelLower.includes("gpt")) return { maxTokens: 128000, reserveTokens: 8000 }
  if (modelLower.includes("deepseek")) return { maxTokens: 128000, reserveTokens: 8000 }
  if (modelLower.includes("qwen")) return { maxTokens: 131072, reserveTokens: 8000 }

  return { maxTokens: 100000, reserveTokens: 2000 }
}

export function getModelMaxTokens(model: string): number {
  return getModelContextLimits(model).maxTokens
}
