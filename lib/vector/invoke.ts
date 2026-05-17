/**
 * Typed Tauri command wrappers for the vector subsystem (ADR-0022).
 *
 * The Rust side exposes two command surfaces:
 *   - Legacy native commands (vector_create_collection, vector_upsert_points,
 *     etc.) backed by VectorState/sqlite-vec. Still called directly from
 *     NativeVectorStore for backwards compatibility.
 *   - New vector_cloud_* commands dispatched through VectorRegistry. These
 *     wrappers below cover that surface.
 *
 * Wire shape: all keys are snake_case (Rust serde default for our types).
 * camelCase JS objects must be transformed at the call boundary.
 */

import { invoke } from "@tauri-apps/api/core"

// Cloud-provider identifier. Native is excluded from cloud commands —
// it has its own (legacy) command surface.
export type CloudProvider = "pinecone" | "qdrant" | "chroma" | "milvus" | "weaviate"

/** Tagged-union credential payload. Mirrors `VectorCredentials` in
 *  `src-tauri/src/vector/credentials.rs`. */
export type VectorCredentials =
  | { provider: "pinecone"; api_key: string; index_name: string; namespace?: string }
  | { provider: "qdrant"; url: string; api_key?: string; collection_name?: string }
  | { provider: "chroma"; url: string; auth_token?: string }
  | {
      provider: "milvus"
      address: string
      token?: string
      username?: string
      password?: string
      ssl?: boolean
      collection_name?: string
    }
  | { provider: "weaviate"; url: string; api_key?: string }

/** Result of `vector_cloud_health_check`. The Rust side serialises this
 *  enum as `"healthy" | { degraded: {...} } | { unreachable: {...} }`. */
export type HealthStatus =
  | "healthy"
  | { degraded: { reason: string } }
  | { unreachable: { reason: string } }

/** Wire-shape of a single point. Mirrors `types::Point`. */
export interface PointWire {
  id: string
  vector: number[]
  payload?: Record<string, unknown>
}

/** Wire-shape of a search hit. Mirrors `types::SearchHit`. */
export interface SearchHitWire {
  id: string
  score: number
  payload?: Record<string, unknown>
  content?: string
}

/** Wire-shape returned by `vector_cloud_query`. */
export interface SearchResponseWire {
  results: SearchHitWire[]
  total: number
  offset: number
  limit: number
}

/** Wire-shape of a collection. Mirrors `types::Collection`. */
export interface CollectionWire {
  name: string
  dimension: number
  description?: string
  embedding_model?: string
  embedding_provider?: string
  metadata?: Record<string, unknown>
  document_count: number
  created_at: string
  updated_at: string
}

/** Wire-shape of a `db::ScrollPage`. */
export interface ScrollPageWire {
  points: PointWire[]
  next_cursor?: string
  has_more: boolean
}

/** Filter operations supported by `types::FilterOp`. */
export type FilterOpWire =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "greater_than_or_equals"
  | "less_than"
  | "less_than_or_equals"
  | "is_null"
  | "is_not_null"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"

export interface FilterWire {
  key: string
  value: unknown
  operation: FilterOpWire
}

export interface CreateCollectionRequestWire {
  name: string
  dimension: number
  description?: string
  embedding_model?: string
  embedding_provider?: string
  metadata?: Record<string, unknown>
}

export interface SearchOptionsWire {
  limit?: number
  offset?: number
  filter?: FilterWire[]
  filter_mode?: "and" | "or"
  include_payload?: boolean
  include_content?: boolean
}

export interface ScrollOptionsWire {
  limit?: number
  cursor?: string
  filter?: FilterWire[]
  filter_mode?: "and" | "or"
}

interface CloudArgs {
  provider: CloudProvider
  configId: string
}

/**
 * Typed namespace for every `vector_*` Tauri command. Calling sites pass
 * camelCase to TS; the Rust serde layer matches snake_case keys.
 */
export const vectorCloudInvoke = {
  // --- Credential management ---
  saveCredentials: (configId: string, credentials: VectorCredentials) =>
    invoke<void>("vector_save_credentials", { configId, credentials }),

  deleteCredentials: (provider: CloudProvider, configId: string) =>
    invoke<void>("vector_delete_credentials", { provider, configId }),

  listConfigured: () => invoke<string[]>("vector_list_configured_providers"),

  // --- Collections ---
  createCollection: (a: CloudArgs, request: CreateCollectionRequestWire) =>
    invoke<void>("vector_cloud_create_collection", { ...a, request }),

  deleteCollection: (a: CloudArgs, name: string) =>
    invoke<void>("vector_cloud_delete_collection", { ...a, name }),

  listCollections: (a: CloudArgs) => invoke<CollectionWire[]>("vector_cloud_list_collections", a),

  getCollection: (a: CloudArgs, name: string) =>
    invoke<CollectionWire>("vector_cloud_get_collection", { ...a, name }),

  // --- Points ---
  upsert: (a: CloudArgs, collection: string, points: PointWire[]) =>
    invoke<void>("vector_cloud_upsert", { ...a, collection, points }),

  deletePoints: (a: CloudArgs, collection: string, ids: string[]) =>
    invoke<void>("vector_cloud_delete_points", { ...a, collection, ids }),

  getPoints: (a: CloudArgs, collection: string, ids: string[]) =>
    invoke<PointWire[]>("vector_cloud_get_points", { ...a, collection, ids }),

  query: (a: CloudArgs, collection: string, queryVector: number[], options: SearchOptionsWire) =>
    invoke<SearchResponseWire>("vector_cloud_query", {
      ...a,
      collection,
      queryVector,
      options,
    }),

  scroll: (a: CloudArgs, collection: string, options: ScrollOptionsWire) =>
    invoke<ScrollPageWire>("vector_cloud_scroll", { ...a, collection, options }),

  count: (a: CloudArgs, collection: string, filter: FilterWire[] | undefined) =>
    invoke<number>("vector_cloud_count", { ...a, collection, filter }),

  // --- Health ---
  healthCheck: (a: CloudArgs) => invoke<HealthStatus>("vector_cloud_health_check", a),
} as const

/** Helper: is the `HealthStatus` value the simple `"healthy"` string? */
export function isHealthy(s: HealthStatus): s is "healthy" {
  return s === "healthy"
}

/** Helper: extract the human-readable reason from a non-healthy status. */
export function healthReason(s: HealthStatus): string | undefined {
  if (s === "healthy") return undefined
  if ("degraded" in s) return s.degraded.reason
  return s.unreachable.reason
}
