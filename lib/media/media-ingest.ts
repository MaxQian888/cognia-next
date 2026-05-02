/**
 * Media ingest helpers used by the plugin Media API.
 *
 * Plugins generate images / videos / audio assets at runtime; the
 * Media API hands those assets to a `MediaCatalogWriter` so the
 * cognia-next workspace surfaces them alongside user-uploaded media.
 *
 * The catalog writer accepts a tagged origin record (so the catalog
 * can show "from plugin X") and returns the asset id. Synchronous
 * writers are supported because most plugin code expects an id back
 * immediately; async writers are accepted too for catalogs that have
 * to round-trip through Dexie / Tauri IPC.
 */

import { nanoid } from "nanoid"

export type MediaAssetKind = "image" | "video" | "audio" | "document"

export interface PluginMediaOrigin {
  type: "plugin" | "user" | "ai"
  sourceId: string
  pluginId?: string
}

export interface PluginMediaAssetInput {
  kind: MediaAssetKind
  /** User-facing filename — `plugin-output.png`, `transcript.txt`, etc. */
  name: string
  mimeType: string
  /** `data:` URL form. Either this or `payload` must be present. */
  dataUrl?: string
  /** Raw bytes (Tauri / Node) or a Blob (web). */
  payload?: Blob | ArrayBuffer | Uint8Array
  width?: number
  height?: number
  durationMs?: number
  metadata?: Record<string, unknown>
  /** Plugin id — added automatically by `registerPluginMediaAsset`. */
  pluginId?: string
  /** Origin tag — auto-filled by `registerPluginMediaAsset` from `pluginId`. */
  origin?: PluginMediaOrigin
  /** Optional session attachment id for chat-thread surfacing. */
  sessionId?: string
}

export interface MediaCatalogEntry extends PluginMediaAssetInput {
  id: string
  origin: PluginMediaOrigin
  createdAt: number
}

export interface MediaCatalogWriter {
  /**
   * Insert a new media asset and return its id (sync or async — the
   * plugin runtime awaits whichever shape the catalog provides).
   */
  addAsset(asset: MediaCatalogEntry): string | Promise<string>
  /** Optional list / remove for plugins that want to manage their own. */
  list?(filter?: { sessionId?: string; pluginId?: string }): Promise<MediaCatalogEntry[]>
  remove?(id: string): Promise<void>
}

const memoryStore = new Map<string, MediaCatalogEntry>()

export function getDefaultMediaCatalogWriter(): MediaCatalogWriter {
  return {
    addAsset(asset) {
      memoryStore.set(asset.id, asset)
      return asset.id
    },
    async list(filter) {
      const out: MediaCatalogEntry[] = []
      for (const entry of memoryStore.values()) {
        if (filter?.sessionId && entry.sessionId !== filter.sessionId) continue
        if (filter?.pluginId && entry.pluginId !== filter.pluginId) continue
        out.push(entry)
      }
      return out.sort((a, b) => a.createdAt - b.createdAt)
    },
    async remove(id) {
      memoryStore.delete(id)
    },
  }
}

/**
 * Register a plugin-produced media asset with the configured catalog
 * writer. Returns the asset id assigned by the catalog (or generated
 * if the catalog supplies none). The function is synchronous from the
 * plugin's point of view — if the catalog returns a Promise, we still
 * return the id but ignore the resolution.
 */
export function registerPluginMediaAsset(
  catalog: MediaCatalogWriter,
  asset: PluginMediaAssetInput
): string {
  const id = `media_${nanoid()}`
  const entry: MediaCatalogEntry = {
    ...asset,
    id,
    pluginId: asset.pluginId,
    origin: asset.origin ?? {
      type: "plugin",
      sourceId: `${asset.pluginId ?? "unknown"}:${asset.name}`,
      pluginId: asset.pluginId,
    },
    createdAt: Date.now(),
  }
  const result = catalog.addAsset(entry)
  if (typeof result === "string") return result
  // Async writer — return the locally-generated id while the write
  // finishes in the background. The plugin can re-list to confirm.
  void result.catch((err) => {
    console.warn("registerPluginMediaAsset: async catalog write failed", err)
  })
  return id
}
