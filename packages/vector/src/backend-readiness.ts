/** Shared dependency-free readiness contracts and registry for vector probes.
 * Host persistence compatibility exports delegate here so probes and consumers
 * observe the same records without importing the application from this package. */
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
  /**
   * Stage labels mirror Cognia's (`configuration` / `reachability` /
   * `operational` / `cleanup`) so ported diagnostic call sites stay valid.
   */
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
const registry = new Map<StorageBackendId, StorageBackendReadinessRecord>()

const DEFAULT_LABELS: Record<StorageBackendId, string> = {
  "web-dexie": "Browser (Dexie/IndexedDB)",
  "vector-native": "Vector (native)",
  "vector-chroma": "Chroma",
  "vector-pinecone": "Pinecone",
  "vector-weaviate": "Weaviate",
  "vector-qdrant": "Qdrant",
  "vector-milvus": "Milvus",
}

function categoryFor(id: StorageBackendId): StorageBackendCategory {
  return id === "web-dexie" ? "browser-persistence" : "vector-provider"
}

export function updateStorageBackendReadiness(
  update: StorageBackendReadinessUpdate
): StorageBackendReadinessRecord {
  const existing = registry.get(update.id)
  const record: StorageBackendReadinessRecord = {
    id: update.id,
    label: update.label ?? existing?.label ?? DEFAULT_LABELS[update.id] ?? update.id,
    category: update.category ?? existing?.category ?? categoryFor(update.id),
    state: update.state,
    lastCheckedAt: update.lastCheckedAt ?? new Date().toISOString(),
    diagnostic: update.diagnostic ?? existing?.diagnostic,
    metadata: update.metadata ?? existing?.metadata,
  }
  registry.set(update.id, record)
  return record
}

export function getStorageBackendReadiness(
  id: StorageBackendId
): StorageBackendReadinessRecord | undefined {
  return registry.get(id)
}

export function listStorageBackendReadiness(): StorageBackendReadinessRecord[] {
  return Array.from(registry.values())
}

export function getStorageBackendsByCategory(
  category: StorageBackendCategory
): StorageBackendReadinessRecord[] {
  return Array.from(registry.values()).filter((r) => r.category === category)
}

export function clearStorageBackendReadiness(): void {
  registry.clear()
}

/**
 * Test-only registry reset. Mirrors Cognia's `resetStorageBackendReadinessRegistryForTest`
 * so ported test suites can use the shared cleanup hook.
 */
export function resetStorageBackendReadinessRegistryForTest(): void {
  registry.clear()
}
export interface StorageBackendVerificationOptions {
  checkedAt?: string
  probeOperational?: boolean
}

export interface StorageBackendVerifier<TConfig = unknown> {
  readonly backendId: StorageBackendId
  verifyReadiness(
    config: TConfig,
    options?: StorageBackendVerificationOptions
  ): Promise<StorageBackendReadinessRecord>
}

export function createStorageBackendDiagnostic(
  code: string,
  message: string,
  at: string = new Date().toISOString(),
  details?: Record<string, unknown>,
  stage?: StorageBackendDiagnostic["stage"]
): StorageBackendDiagnostic {
  return { code, message, at, details, stage }
}
