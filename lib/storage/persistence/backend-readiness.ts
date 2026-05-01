/**
 * Minimal in-memory registry of storage backend readiness states.
 *
 * Mirrors Cognia's `lib/storage/persistence/backend-readiness.ts` API surface
 * but with no encryption / no migration / no event bus — just enough to let
 * the ported RAG/vector code report and inspect backend health.
 */

import type {
  StorageBackendCategory,
  StorageBackendId,
  StorageBackendReadinessRecord,
  StorageBackendReadinessUpdate,
} from "./types"

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
