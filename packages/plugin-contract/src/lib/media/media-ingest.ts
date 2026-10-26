/**
 * The plugin contract's share of `lib/media/media-ingest.ts`, which re-exports these.
 */
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
