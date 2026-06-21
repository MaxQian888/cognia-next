/**
 * One-shot credential migration from the pre-ADR-0022 cleartext Zustand
 * layout to the OS keyring.
 *
 * Pre-migration: `useVectorStore` persisted `pineconeApiKey`,
 * `qdrantUrl`, `qdrantApiKey`, `chromaServerUrl`, `milvusAddress`,
 * `milvusToken/username/password`, `weaviateUrl`, `weaviateApiKey`
 * directly in localStorage under `cognia-vector-settings`.
 *
 * Post-migration: those fields are removed from the persisted blob.
 * Their values are written into the OS keyring under predictable
 * `migrated-<provider>` config-ids, and the corresponding `*ConfigId`
 * pointers land in the Zustand state.
 *
 * Idempotency: the localStorage marker `vector-credentials-migrated`
 * gates re-runs. Set after a successful (or no-op) migration.
 */

import { vectorCloudInvoke, type VectorCredentials } from "../invoke"

const STORAGE_KEY = "cognia-vector-settings"
const MIGRATION_FLAG = "vector-credentials-migrated"

/** Legacy persisted shape (pre-ADR-0022). Inlined so deleting fields
 *  from VectorSettings doesn't break the migrator's type-safety. */
interface LegacyVectorSettings {
  provider?: string
  pineconeApiKey?: string
  pineconeIndexName?: string
  pineconeNamespace?: string
  qdrantUrl?: string
  qdrantApiKey?: string
  qdrantCollectionName?: string
  chromaServerUrl?: string
  mode?: string
  milvusAddress?: string
  milvusToken?: string
  milvusUsername?: string
  milvusPassword?: string
  milvusSsl?: boolean
  milvusCollectionName?: string
  weaviateUrl?: string
  weaviateApiKey?: string
  [key: string]: unknown
}

export interface MigrationResult {
  ran: boolean
  migrated: Array<{ provider: string; configId: string }>
}

export async function migrateVectorCredentials(): Promise<MigrationResult> {
  if (typeof window === "undefined") {
    return { ran: false, migrated: [] }
  }
  if (window.localStorage.getItem(MIGRATION_FLAG) === "true") {
    return { ran: false, migrated: [] }
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(MIGRATION_FLAG, "true")
    return { ran: true, migrated: [] }
  }

  let parsed: { state?: { settings?: LegacyVectorSettings }; version?: number }
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt blob — clear the flag and bail.
    window.localStorage.setItem(MIGRATION_FLAG, "true")
    return { ran: true, migrated: [] }
  }
  const settings = parsed.state?.settings ?? {}
  const migrated: MigrationResult["migrated"] = []

  if (settings.pineconeApiKey && settings.pineconeIndexName) {
    const creds: VectorCredentials = {
      provider: "pinecone",
      api_key: settings.pineconeApiKey,
      index_name: settings.pineconeIndexName,
      namespace: settings.pineconeNamespace,
    }
    await vectorCloudInvoke.saveCredentials("migrated-pinecone", creds).catch(() => undefined)
    migrated.push({ provider: "pinecone", configId: "migrated-pinecone" })
  }
  if (settings.qdrantUrl) {
    await vectorCloudInvoke
      .saveCredentials("migrated-qdrant", {
        provider: "qdrant",
        url: settings.qdrantUrl,
        api_key: settings.qdrantApiKey,
        collection_name: settings.qdrantCollectionName,
      })
      .catch(() => undefined)
    migrated.push({ provider: "qdrant", configId: "migrated-qdrant" })
  }
  if (settings.chromaServerUrl) {
    await vectorCloudInvoke
      .saveCredentials("migrated-chroma", {
        provider: "chroma",
        url: settings.chromaServerUrl,
      })
      .catch(() => undefined)
    migrated.push({ provider: "chroma", configId: "migrated-chroma" })
  }
  if (settings.milvusAddress) {
    await vectorCloudInvoke
      .saveCredentials("migrated-milvus", {
        provider: "milvus",
        address: settings.milvusAddress,
        token: settings.milvusToken,
        username: settings.milvusUsername,
        password: settings.milvusPassword,
        ssl: settings.milvusSsl ?? false,
        collection_name: settings.milvusCollectionName,
      })
      .catch(() => undefined)
    migrated.push({ provider: "milvus", configId: "migrated-milvus" })
  }
  if (settings.weaviateUrl) {
    await vectorCloudInvoke
      .saveCredentials("migrated-weaviate", {
        provider: "weaviate",
        url: settings.weaviateUrl,
        api_key: settings.weaviateApiKey,
      })
      .catch(() => undefined)
    migrated.push({ provider: "weaviate", configId: "migrated-weaviate" })
  }

  // Strip cleartext fields + insert configId pointers in place.
  const cleaned: { state?: { settings?: Record<string, unknown> } } = parsed
  if (cleaned.state?.settings) {
    const s = cleaned.state.settings
    delete s.pineconeApiKey
    delete s.pineconeIndexName
    delete s.pineconeNamespace
    delete s.qdrantUrl
    delete s.qdrantApiKey
    delete s.qdrantCollectionName
    delete s.chromaServerUrl
    delete s.mode
    delete s.milvusAddress
    delete s.milvusToken
    delete s.milvusUsername
    delete s.milvusPassword
    delete s.milvusSsl
    delete s.milvusCollectionName
    delete s.weaviateUrl
    delete s.weaviateApiKey
    for (const { provider, configId } of migrated) {
      s[`${provider}ConfigId`] = configId
    }
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
  window.localStorage.setItem(MIGRATION_FLAG, "true")
  return { ran: true, migrated }
}
