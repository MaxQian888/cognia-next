/**
 * Storage backend readiness types — cognia-next minimal subset.
 *
 * Cognia ships a full storage backend abstraction (`unified-persistence-service`,
 * encryption, recovery, etc.). cognia-next uses Dexie as its single backend
 * and only needs the readiness reporting surface so the ported `lib/vector`
 * and `lib/ai/rag` code can talk about backend health without a full registry.
 *
 * Keep this file tiny and dependency-free. A future PR can replace it with a
 * real implementation if cognia-next decides to manage multiple backends.
 */

export type StorageBackendId =
  | "web-dexie"
  | "vector-native"
  | "vector-chroma"
  | "vector-pinecone"
  | "vector-weaviate"
  | "vector-qdrant"
  | "vector-milvus"

export type StorageBackendCategory = "browser-persistence" | "vector-provider" | "knowledge-store"

export type StorageBackendReadinessState =
  | "unconfigured"
  | "configured"
  | "reachable"
  | "operational"
  | "degraded"

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
