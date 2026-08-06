/**
 * Persisted twin runtime configuration. Stored as a single row in the
 * `settings` Dexie table under the id `twin-runtime` so we don't fork the
 * existing settings infrastructure (single-row singleton + reactive
 * `useLiveQuery`). The shape lives in `@/types/twin` so other modules can
 * reference it without pulling Dexie into their import graph.
 *
 * API keys are resolved through the shared credential seam. The Dexie row
 * stores stable references only; legacy cleartext rows are migrated after a
 * durable Vault/keyring adapter becomes available.
 */

import { getDb } from "./schema"
import { isTauri } from "@/lib/tauri"
import { DEFAULT_TWIN_RUNTIME_SETTINGS, type TwinRuntimeSettings } from "@/types/twin"
import { createKeyringStore } from "@/lib/credentials/keyring-store"

const TWIN_RUNTIME_ID = "twin-runtime"

interface TwinRuntimeSettingsRow {
  id: string
  payload: TwinRuntimeSettings
  secretRefs?: Partial<Record<TwinRuntimeSecretSlot, string>>
}

type TwinRuntimeSecretSlot = "embedding" | "llm" | "qdrant" | "pinecone" | "weaviate" | "milvus"

const secretStore = createKeyringStore("twin-runtime")
const SECRET_KEY_BY_SLOT: Record<TwinRuntimeSecretSlot, string> = {
  embedding: "embedding-api-key",
  llm: "llm-api-key",
  qdrant: "vector-qdrant-api-key",
  pinecone: "vector-pinecone-api-key",
  weaviate: "vector-weaviate-api-key",
  milvus: "vector-milvus-token",
}

function isTwinRuntimeRow(row: unknown): row is TwinRuntimeSettingsRow {
  if (!row || typeof row !== "object") return false
  const candidate = row as { id?: unknown; payload?: unknown }
  if (candidate.id !== TWIN_RUNTIME_ID) return false
  return !!candidate.payload && typeof candidate.payload === "object"
}

// `settings.get` is typed against the singleton AppSettings shape (id =
// "singleton"). The twin runtime row breaks that constraint deliberately — we
// piggy-back on the same table to avoid a schema bump just for one config
// blob. Wrap every Dexie touch in a small adapter so the cast lives in one
// place rather than scattered across consumers.
function settingsTable() {
  return getDb().settings as unknown as {
    get(id: string): Promise<unknown>
    put(row: unknown): Promise<unknown>
  }
}

/**
 * Derives the default vectorBackend at runtime rather than at module
 * import time.  isTauri() is falsy in SSR / static-export builds, so
 * DEFAULT_TWIN_RUNTIME_SETTINGS.storage.vectorBackend stays "qdrant" as the
 * web baseline and this function is the only call site that flips to
 * "native" for fresh desktop users.
 */
function derivedVectorBackendDefault(): TwinRuntimeSettings["storage"]["vectorBackend"] {
  return isTauri() ? "native" : DEFAULT_TWIN_RUNTIME_SETTINGS.storage.vectorBackend
}

export async function getTwinRuntimeSettings(): Promise<TwinRuntimeSettings> {
  const row = await settingsTable().get(TWIN_RUNTIME_ID)
  if (isTwinRuntimeRow(row)) {
    // Defensive merge — a stored row from an older release may be missing
    // newly-added fields; we backfill from the defaults instead of crashing
    // on a partial payload.
    const storageDefault = {
      ...DEFAULT_TWIN_RUNTIME_SETTINGS.storage,
      vectorBackend: derivedVectorBackendDefault(),
    }
    const merged: TwinRuntimeSettings = {
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      ...row.payload,
      storage: { ...storageDefault, ...row.payload.storage },
      embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, ...row.payload.embedding },
      llm: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.llm, ...row.payload.llm },
    }
    if (row.secretRefs) await hydrateSecretReferences(merged, row.secretRefs)
    else if (hasInlineSecrets(merged) && secretStore.isPersistent?.()) {
      // A durable adapter is available, so migrate the legacy row only after
      // the keyring/Vault writes complete. A failure leaves the old row intact
      // and the next read can retry safely.
      await saveTwinRuntimeSettings(merged)
    }
    return merged
  }
  return {
    ...DEFAULT_TWIN_RUNTIME_SETTINGS,
    storage: {
      ...DEFAULT_TWIN_RUNTIME_SETTINGS.storage,
      vectorBackend: derivedVectorBackendDefault(),
    },
  }
}

export async function saveTwinRuntimeSettings(payload: TwinRuntimeSettings): Promise<void> {
  const existing = await settingsTable().get(TWIN_RUNTIME_ID)
  const previousRefs = isTwinRuntimeRow(existing) ? existing.secretRefs : undefined
  const values = secretValues(payload)
  const secretRefs: Partial<Record<TwinRuntimeSecretSlot, string>> = {}

  for (const [slot, value] of Object.entries(values) as [TwinRuntimeSecretSlot, string][]) {
    const key = SECRET_KEY_BY_SLOT[slot]
    if (value) {
      await secretStore.save(key, value)
      secretRefs[slot] = key
    } else if (previousRefs?.[slot]) {
      if (secretStore.isPersistent?.()) {
        await secretStore.delete(previousRefs[slot])
      } else {
        // The Web Vault may have been locked between read and save. Preserve
        // the durable reference rather than orphaning an encrypted secret that
        // cannot currently be inspected or deleted.
        secretRefs[slot] = previousRefs[slot]
      }
    }
  }

  const row: TwinRuntimeSettingsRow = {
    id: TWIN_RUNTIME_ID,
    payload: stripInlineSecrets(payload),
    ...(Object.keys(secretRefs).length > 0 ? { secretRefs } : {}),
  }
  await settingsTable().put(row)
}

function secretValues(payload: TwinRuntimeSettings): Record<TwinRuntimeSecretSlot, string> {
  return {
    embedding: payload.embedding.apiKey.trim(),
    llm: payload.llm.apiKey.trim(),
    qdrant: payload.storage.qdrant?.apiKey?.trim() ?? "",
    pinecone: payload.storage.pinecone?.apiKey.trim() ?? "",
    weaviate: payload.storage.weaviate?.apiKey?.trim() ?? "",
    milvus: payload.storage.milvus?.token?.trim() ?? "",
  }
}

function hasInlineSecrets(payload: TwinRuntimeSettings): boolean {
  return Object.values(secretValues(payload)).some(Boolean)
}

function stripInlineSecrets(payload: TwinRuntimeSettings): TwinRuntimeSettings {
  return {
    ...payload,
    embedding: { ...payload.embedding, apiKey: "" },
    llm: { ...payload.llm, apiKey: "" },
    storage: {
      ...payload.storage,
      ...(payload.storage.qdrant
        ? { qdrant: { ...payload.storage.qdrant, apiKey: undefined } }
        : {}),
      ...(payload.storage.pinecone
        ? { pinecone: { ...payload.storage.pinecone, apiKey: "" } }
        : {}),
      ...(payload.storage.weaviate
        ? { weaviate: { ...payload.storage.weaviate, apiKey: undefined } }
        : {}),
      ...(payload.storage.milvus
        ? { milvus: { ...payload.storage.milvus, token: undefined } }
        : {}),
    },
  }
}

async function hydrateSecretReferences(
  payload: TwinRuntimeSettings,
  refs: Partial<Record<TwinRuntimeSecretSlot, string>>
): Promise<void> {
  const loaded = await Promise.all(
    (Object.entries(refs) as [TwinRuntimeSecretSlot, string][]).map(
      async ([slot, key]) => [slot, await secretStore.load(key)] as const
    )
  )
  for (const [slot, value] of loaded) {
    if (!value) continue
    if (slot === "embedding") payload.embedding.apiKey = value
    else if (slot === "llm") payload.llm.apiKey = value
    else if (slot === "qdrant" && payload.storage.qdrant) payload.storage.qdrant.apiKey = value
    else if (slot === "pinecone" && payload.storage.pinecone)
      payload.storage.pinecone.apiKey = value
    else if (slot === "weaviate" && payload.storage.weaviate)
      payload.storage.weaviate.apiKey = value
    else if (slot === "milvus" && payload.storage.milvus) payload.storage.milvus.token = value
  }
}

/**
 * `useLiveQuery`-friendly observer. Returns the live row (defaults applied).
 * Components subscribe via `useLiveQuery(observeTwinRuntimeSettings)`.
 */
export function observeTwinRuntimeSettings(): Promise<TwinRuntimeSettings> {
  return getTwinRuntimeSettings()
}
