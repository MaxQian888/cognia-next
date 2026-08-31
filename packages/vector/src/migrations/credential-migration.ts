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
const CURRENT_STORE_VERSION = 2

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

  // A failed WRITE is retryable; an incomplete legacy record is not. Only the
  // former may hold the migration flag back — see the note at the flag below.
  let writeFailed = false
  const save = async (provider: string, configId: string, credentials: VectorCredentials) => {
    try {
      await vectorCloudInvoke.saveCredentials(configId, credentials)
      migrated.push({ provider, configId })
    } catch {
      // Preserve the cleartext source fields and leave the migration flag
      // unset. Desktop boot can retry after a transient keyring failure.
      writeFailed = true
    }
  }

  if (settings.pineconeApiKey && settings.pineconeIndexName) {
    const creds: VectorCredentials = {
      provider: "pinecone",
      api_key: settings.pineconeApiKey,
      index_name: settings.pineconeIndexName,
      namespace: settings.pineconeNamespace,
    }
    await save("pinecone", "migrated-pinecone", creds)
  }
  if (settings.qdrantUrl) {
    await save("qdrant", "migrated-qdrant", {
      provider: "qdrant",
      url: settings.qdrantUrl,
      api_key: settings.qdrantApiKey,
      collection_name: settings.qdrantCollectionName,
    })
  }
  if (settings.chromaServerUrl) {
    await save("chroma", "migrated-chroma", {
      provider: "chroma",
      url: settings.chromaServerUrl,
    })
  }
  if (settings.milvusAddress) {
    await save("milvus", "migrated-milvus", {
      provider: "milvus",
      address: settings.milvusAddress,
      token: settings.milvusToken,
      username: settings.milvusUsername,
      password: settings.milvusPassword,
      ssl: settings.milvusSsl ?? false,
      collection_name: settings.milvusCollectionName,
    })
  }
  if (settings.weaviateUrl) {
    await save("weaviate", "migrated-weaviate", {
      provider: "weaviate",
      url: settings.weaviateUrl,
      api_key: settings.weaviateApiKey,
    })
  }

  // Strip only credentials that were durably written, then insert pointers.
  // Failed or incomplete records stay intact and retryable.
  const cleaned: { state?: { settings?: Record<string, unknown> } } = parsed
  if (cleaned.state?.settings) {
    const s = cleaned.state.settings
    for (const { provider, configId } of migrated) {
      s[`${provider}ConfigId`] = configId
      if (provider === "pinecone") {
        delete s.pineconeApiKey
        delete s.pineconeIndexName
        delete s.pineconeNamespace
      } else if (provider === "qdrant") {
        delete s.qdrantUrl
        delete s.qdrantApiKey
        delete s.qdrantCollectionName
      } else if (provider === "chroma") {
        delete s.chromaServerUrl
        delete s.mode
      } else if (provider === "milvus") {
        delete s.milvusAddress
        delete s.milvusToken
        delete s.milvusUsername
        delete s.milvusPassword
        delete s.milvusSsl
        delete s.milvusCollectionName
      } else if (provider === "weaviate") {
        delete s.weaviateUrl
        delete s.weaviateApiKey
      }
    }
  }
  // Only a retryable WRITE failure keeps the flag off. Scanning for surviving
  // cleartext instead would never clear for a record that cannot satisfy its
  // own guard — `pineconeApiKey` with no `pineconeIndexName`, `milvusToken`
  // with no `milvusAddress` — because that provider is never attempted, so its
  // fields are never deleted. Such a record would re-run this migration on
  // every boot forever, re-issuing keyring writes for every other provider.
  const remaining = cleaned.state?.settings ?? {}
  const hasRetryableCredentials =
    writeFailed &&
    [
      "pineconeApiKey",
      "pineconeIndexName",
      "pineconeNamespace",
      "qdrantUrl",
      "qdrantApiKey",
      "qdrantCollectionName",
      "chromaServerUrl",
      "milvusAddress",
      "milvusToken",
      "milvusUsername",
      "milvusPassword",
      "milvusCollectionName",
      "weaviateUrl",
      "weaviateApiKey",
    ].some((key) => Boolean(remaining[key]))
  // The version stamp travels with the flag, not with the write. Bumping it on
  // the retryable path would make the record CLAIM to be upgraded while its
  // cleartext is still on disk, so a later v1 to v2 fixup would skip exactly
  // the records that still need one.
  if (!hasRetryableCredentials) parsed.version = CURRENT_STORE_VERSION
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
  if (!hasRetryableCredentials) window.localStorage.setItem(MIGRATION_FLAG, "true")
  return { ran: true, migrated }
}
