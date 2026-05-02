/**
 * Persisted twin runtime configuration. Stored as a single row in the
 * `settings` Dexie table under the id `twin-runtime` so we don't fork the
 * existing settings infrastructure (single-row singleton + reactive
 * `useLiveQuery`). The shape lives in `@/types/twin` so other modules can
 * reference it without pulling Dexie into their import graph.
 *
 * Trust model (v1): API keys are stored in cleartext, matching
 * `AppSettings.apiKey`. A future change can move them behind the Tauri
 * stronghold transparently — readers / writers go through this module.
 */

import { getDb } from "./schema"
import { isTauri } from "@/lib/tauri"
import { DEFAULT_TWIN_RUNTIME_SETTINGS, type TwinRuntimeSettings } from "@/types/twin"

const TWIN_RUNTIME_ID = "twin-runtime"

interface TwinRuntimeSettingsRow {
  id: string
  payload: TwinRuntimeSettings
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
    return {
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      ...row.payload,
      storage: { ...storageDefault, ...row.payload.storage },
      embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, ...row.payload.embedding },
      llm: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.llm, ...row.payload.llm },
    }
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
  const row: TwinRuntimeSettingsRow = { id: TWIN_RUNTIME_ID, payload }
  await settingsTable().put(row)
}

/**
 * `useLiveQuery`-friendly observer. Returns the live row (defaults applied).
 * Components subscribe via `useLiveQuery(observeTwinRuntimeSettings)`.
 */
export function observeTwinRuntimeSettings(): Promise<TwinRuntimeSettings> {
  return getTwinRuntimeSettings()
}
