/**
 * Local Character Pack store (ADR-0030).
 *
 * Standalone `.cognia-pack.json` files live on disk under
 *   `<appDataDir()>/cognia/local-character-packs/<pack-id>.cognia-pack.json`
 * and are registered into the in-memory `character-pack-registry` with
 * `pluginId = "local:imported"`. They are NOT plugins — the marketplace
 * install pipeline expects a Tauri-extracted tarball, which a single
 * JSON file is not. Instead this store runs a lightweight scan-on-boot
 * + import / delete / export workflow that bypasses the plugin manager
 * entirely.
 *
 * Lifecycle invariants:
 *  - `scanAndRegisterLocalPacks()` is idempotent; calling it twice
 *    re-registers the same pack ids (the overlay registry's `register`
 *    is itself idempotent — it replaces the previous entry).
 *  - `deleteLocalPack(packId)` removes the file AND unregisters the
 *    overlay entry in one step.
 *  - User-cloned characters (Dexie rows with `sourcePluginId === "local:imported"`)
 *    survive `deleteLocalPack` — only the source overlay disappears.
 *
 * Web mode: every operation is a no-op or returns an error result.
 * The Settings UI gates the Import button with `isTauri()` so users
 * never see a broken affordance.
 */

import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"
import {
  __resetCharacterPacksForTesting,
  getCharacterPack,
  getCharacterPackEntry,
  registerCharacterPack,
  unregisterCharacterPackById,
} from "@/lib/plugin/registries/character-pack-registry"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@/lib/logging"
import {
  CHARACTER_PACK_FILE_SCHEMA_VERSION,
  parseLocalPackFile,
  serializeLocalPackFile,
  type LocalCharacterPackFile,
} from "./schema"

const log = loggers.plugin

/**
 * pluginId tag used for every locally-imported pack so the picker UI can
 * surface "From local file" and the registry's `unregisterByPlugin` can
 * (in a future "Forget all local packs" feature) clean them up in bulk.
 */
export const LOCAL_PACK_PLUGIN_ID = "local:imported"

/**
 * Re-export the schema constant so tests and Settings UI can render the
 * supported format version without re-importing from `./schema`.
 */
export { CHARACTER_PACK_FILE_SCHEMA_VERSION }

export type LocalPackOperationResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * File-system abstraction. The Tauri implementation lives behind a lazy
 * dynamic import so this module remains tree-shakable in web builds.
 * Tests inject a synchronous in-memory implementation via
 * `__setLocalPackFsForTesting`.
 */
export interface LocalPackFsAdapter {
  /**
   * Ensure the local-pack directory exists and return the absolute path
   * suitable for `join()` operations. Returns null when the host can't
   * resolve a writable directory (web mode, missing permission, etc.).
   */
  resolveDir: () => Promise<string | null>
  /** List `.cognia-pack.json` files in the directory. */
  listFiles: (dir: string) => Promise<string[]>
  /** Read a file as UTF-8. Returns null if missing. */
  readFile: (absPath: string) => Promise<string | null>
  /** Write a file atomically (best-effort). */
  writeFile: (absPath: string, body: string) => Promise<void>
  /** Delete a file. Idempotent — missing files are not an error. */
  deleteFile: (absPath: string) => Promise<void>
  /** Compute the canonical absolute path for a given packId. */
  pathFor: (dir: string, packId: string) => Promise<string>
}

let fsAdapter: LocalPackFsAdapter | null = null

function defaultTauriFs(): LocalPackFsAdapter {
  return {
    async resolveDir(): Promise<string | null> {
      if (!isTauri()) return null
      try {
        const { appDataDir, join } = await import("@tauri-apps/api/path")
        const { mkdir } = await import("@tauri-apps/plugin-fs")
        const root = await appDataDir()
        const dir = await join(root, "cognia", "local-character-packs")
        try {
          await mkdir(dir, { recursive: true })
        } catch {
          // Already exists or unwritable — the subsequent read/write
          // will surface a useful error.
        }
        return dir
      } catch (err) {
        log.warn("local-pack-store: resolveDir failed", { err })
        return null
      }
    },
    async listFiles(dir): Promise<string[]> {
      const { readDir } = await import("@tauri-apps/plugin-fs")
      const entries = await readDir(dir)
      return entries
        .filter((e) => typeof e.name === "string" && e.name.endsWith(".cognia-pack.json"))
        .map((e) => e.name as string)
    },
    async readFile(absPath): Promise<string | null> {
      try {
        const { readTextFile } = await import("@tauri-apps/plugin-fs")
        return await readTextFile(absPath)
      } catch {
        return null
      }
    },
    async writeFile(absPath, body): Promise<void> {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs")
      await writeTextFile(absPath, body)
    },
    async deleteFile(absPath): Promise<void> {
      try {
        const { remove } = await import("@tauri-apps/plugin-fs")
        await remove(absPath)
      } catch {
        // File missing or permission denied — treat as a no-op; the
        // registry side of the delete is what matters for UI state.
      }
    },
    async pathFor(dir, packId): Promise<string> {
      const { join } = await import("@tauri-apps/api/path")
      // Filename is the packId verbatim — pack ids are validated to be
      // safe (no path separators) by `validatePackShape` in schema.ts.
      return join(dir, `${packId}.cognia-pack.json`)
    },
  }
}

function getFs(): LocalPackFsAdapter {
  if (!fsAdapter) {
    fsAdapter = defaultTauriFs()
  }
  return fsAdapter
}

/** Test-only: swap the fs adapter for a deterministic in-memory one. */
export function __setLocalPackFsForTesting(adapter: LocalPackFsAdapter | null): void {
  fsAdapter = adapter
}

/** Test-only: reset both the registry and the adapter. */
export function __resetLocalPackStoreForTesting(): void {
  fsAdapter = null
  __resetCharacterPacksForTesting()
}

/**
 * Scan the local-pack directory and register every valid pack into the
 * overlay registry. Called once on app boot (see boot wiring) and again
 * after any import / delete operation to keep the in-memory view in sync.
 * Files that fail to parse are skipped with a `warn` — they don't block
 * other packs from registering.
 *
 * Returns a summary so callers (Settings UI, boot logger) can surface
 * counts and reasons. `registered` includes already-known pack ids that
 * got refreshed — the registry's `register` is idempotent.
 */
export async function scanAndRegisterLocalPacks(): Promise<{
  registered: string[]
  skipped: Array<{ filename: string; reason: string }>
}> {
  const fs = getFs()
  const dir = await fs.resolveDir()
  if (!dir) return { registered: [], skipped: [] }

  let filenames: string[] = []
  try {
    filenames = await fs.listFiles(dir)
  } catch (err) {
    log.warn("local-pack-store: listFiles failed", { err })
    return { registered: [], skipped: [] }
  }

  const registered: string[] = []
  const skipped: Array<{ filename: string; reason: string }> = []
  for (const filename of filenames) {
    const absPath = await fs.pathFor(dir, filename.replace(/\.cognia-pack\.json$/, ""))
    const body = await fs.readFile(absPath)
    if (body === null) {
      skipped.push({ filename, reason: "Unable to read file" })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (err) {
      skipped.push({ filename, reason: `Invalid JSON: ${(err as Error).message}` })
      continue
    }
    const result = parseLocalPackFile(parsed)
    if (!result.ok) {
      skipped.push({ filename, reason: result.error })
      continue
    }
    registerCharacterPack(result.file.pack.id, result.file.pack, {
      pluginId: LOCAL_PACK_PLUGIN_ID,
    })
    registered.push(result.file.pack.id)
  }
  log.info("local-pack-store: scan complete", {
    registeredCount: registered.length,
    skippedCount: skipped.length,
  })
  return { registered, skipped }
}

export type LocalPackImportConflict = "rejected-existing-plugin-pack"

/**
 * Import a `.cognia-pack.json` payload. Accepts either a parsed object
 * (most common — Settings UI parses the file before calling) or a raw
 * JSON string. Writes the file to disk and registers the pack
 * synchronously so the picker UI sees it on the next render.
 *
 * Conflict policy:
 *  - Same id, already registered by a real plugin (pluginId ≠
 *    LOCAL_PACK_PLUGIN_ID): refuse the import; return
 *    `{ ok: false, error: ... }`. The local-pack tier never shadows a
 *    real plugin's contribution. Users wanting to override should
 *    duplicate the overlay character into Dexie instead.
 *  - Same id, already a local pack: overwrite (the user explicitly
 *    re-imported, presumably with a newer version). The registry's
 *    `register` is idempotent.
 *  - Unrelated id: write + register.
 */
export async function importLocalPack(
  payload: unknown | string
): Promise<LocalPackOperationResult<{ packId: string }>> {
  if (!isTauri()) {
    return { ok: false, error: "Local pack import is not available in web mode" }
  }
  let raw: unknown
  if (typeof payload === "string") {
    try {
      raw = JSON.parse(payload)
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${(err as Error).message}` }
    }
  } else {
    raw = payload
  }
  const result = parseLocalPackFile(raw)
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  const pack = result.file.pack

  // Conflict check: another plugin already contributed this id.
  const existingEntry = getCharacterPackEntry(pack.id)
  if (existingEntry && existingEntry.pluginId && existingEntry.pluginId !== LOCAL_PACK_PLUGIN_ID) {
    return {
      ok: false,
      error: `Pack id "${pack.id}" is already provided by plugin "${existingEntry.pluginId}". Rename the pack before importing.`,
    }
  }

  const fs = getFs()
  const dir = await fs.resolveDir()
  if (!dir) {
    return { ok: false, error: "Cannot resolve local-pack directory" }
  }
  const absPath = await fs.pathFor(dir, pack.id)
  try {
    await fs.writeFile(absPath, serializeLocalPackFile(pack, result.file.signature))
  } catch (err) {
    return { ok: false, error: `Write failed: ${(err as Error).message}` }
  }
  registerCharacterPack(pack.id, pack, { pluginId: LOCAL_PACK_PLUGIN_ID })
  return { ok: true, value: { packId: pack.id } }
}

/**
 * Delete a locally-imported pack: unregister + remove file. Only acts on
 * packs whose registered pluginId equals `LOCAL_PACK_PLUGIN_ID` — calling
 * `deleteLocalPack` for a real-plugin pack id is a no-op (and reports an
 * error so the caller can show a sensible message).
 */
export async function deleteLocalPack(
  packId: string
): Promise<LocalPackOperationResult<{ packId: string }>> {
  const entry = getCharacterPackEntry(packId)
  if (!entry) {
    return { ok: false, error: `Pack "${packId}" is not registered` }
  }
  if (entry.pluginId !== LOCAL_PACK_PLUGIN_ID) {
    return {
      ok: false,
      error: `Pack "${packId}" is provided by plugin "${entry.pluginId}" — disable the plugin to remove it`,
    }
  }
  unregisterCharacterPackById(packId)
  if (isTauri()) {
    const fs = getFs()
    const dir = await fs.resolveDir()
    if (dir) {
      const absPath = await fs.pathFor(dir, packId)
      await fs.deleteFile(absPath)
    }
  }
  return { ok: true, value: { packId } }
}

/**
 * Export an in-memory pack (locally-imported or plugin-contributed) as a
 * canonical `.cognia-pack.json` string. The caller drives the actual
 * file-save dialog. Plugin-contributed packs are exported verbatim — the
 * exported file carries no plugin identity, so re-importing it produces
 * a `local:imported` pack with the same content.
 */
export function exportPack(packId: string): LocalPackOperationResult<{
  filename: string
  body: string
  file: LocalCharacterPackFile
}> {
  const pack = getCharacterPack(packId)
  if (!pack) {
    return { ok: false, error: `Pack "${packId}" is not registered` }
  }
  const body = serializeLocalPackFile(pack as PluginCharacterPackDef)
  return {
    ok: true,
    value: {
      filename: `${pack.id}.cognia-pack.json`,
      body,
      file: {
        schemaVersion: CHARACTER_PACK_FILE_SCHEMA_VERSION,
        pack: pack as PluginCharacterPackDef,
      },
    },
  }
}
