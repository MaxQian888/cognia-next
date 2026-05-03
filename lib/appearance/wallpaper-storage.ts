"use client"

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import type { Wallpaper, WallpaperSource } from "@/types/appearance"

const INDEXEDDB_NAME = "cognia-wallpapers"
const INDEXEDDB_STORE = "blobs"
const INDEXEDDB_VERSION = 1
/** Hard cap mirroring the Rust-side guard. UI rejects bigger uploads earlier. */
export const MAX_WALLPAPER_BYTES = 32 * 1024 * 1024

/** Result of saving a freshly-uploaded image. */
export interface SaveImageResult {
  source: Extract<WallpaperSource, { kind: "image" }>
  /** Object URL (web) or data URL (Tauri) for immediate `<img src>` use. */
  previewUrl: string
}

interface SaveImageInput {
  bytes: ArrayBuffer
  mime: string
  width: number
  height: number
  /** Pre-generated id used both as the Dexie/IDB key and the disk file stem. */
  id: string
}

/**
 * Persist an uploaded image. On Tauri this writes the bytes to
 * `<app_data>/cognia/wallpapers/<id>.<ext>` via the `wallpaper_save` command;
 * on web it falls back to an IndexedDB Blob keyed by `id`. The returned
 * `WallpaperSource` should be stored verbatim in `Wallpaper.source`.
 */
export async function saveImage(input: SaveImageInput): Promise<SaveImageResult> {
  if (input.bytes.byteLength > MAX_WALLPAPER_BYTES) {
    throw new Error(`wallpaper exceeds ${MAX_WALLPAPER_BYTES} bytes`)
  }
  if (isTauri()) {
    return saveImageToDisk(input)
  }
  return saveImageToIndexedDb(input)
}

async function saveImageToDisk(input: SaveImageInput): Promise<SaveImageResult> {
  const ext = mimeToExtension(input.mime)
  const fileName = `${input.id}.${ext}`
  const base64 = arrayBufferToBase64(input.bytes)
  const saved = await invoke<{ rel_path: string; abs_path: string; bytes: number }>(
    "wallpaper_save",
    { fileName, base64Data: base64 }
  )
  // `wallpaper_read_data_url` is what we'll use later when applying the
  // background; for the immediate preview after upload we already have the
  // bytes in memory, so just synthesize the data URL here. Avoids a
  // round-trip right after writing.
  const previewUrl = `data:${input.mime};base64,${base64}`
  return {
    source: {
      kind: "image",
      storage: "disk",
      relPath: saved.rel_path,
      mime: input.mime,
      width: input.width,
      height: input.height,
    },
    previewUrl,
  }
}

async function saveImageToIndexedDb(input: SaveImageInput): Promise<SaveImageResult> {
  const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mime })
  await idbPut(input.id, blob)
  const previewUrl = URL.createObjectURL(blob)
  return {
    source: {
      kind: "image",
      storage: "indexeddb",
      blobKey: input.id,
      mime: input.mime,
      width: input.width,
      height: input.height,
    },
    previewUrl,
  }
}

/**
 * Resolve a `WallpaperSource` to a string suitable for
 * `background-image: url(...)`. Returns a gradient/color CSS value
 * unchanged, materialises images into data URLs (Tauri) or Object URLs
 * (web), and forwards inline data URLs as-is.
 *
 * The caller is responsible for revoking any returned Object URL when the
 * wallpaper changes — `disposeUrl()` is provided as a paired helper.
 */
export async function resolveSourceToCss(source: WallpaperSource): Promise<string> {
  if (source.kind === "color") return source.value
  if (source.kind === "gradient") return source.css
  switch (source.storage) {
    case "data-url":
      return `url('${source.dataUrl}')`
    case "disk": {
      const result = await invoke<{ data_url: string }>("wallpaper_read_data_url", {
        fileName: source.relPath,
      })
      return `url('${result.data_url}')`
    }
    case "indexeddb": {
      const blob = await idbGet(source.blobKey)
      if (!blob) throw new Error(`wallpaper blob missing: ${source.blobKey}`)
      return `url('${URL.createObjectURL(blob)}')`
    }
  }
}

/**
 * Revoke an Object URL produced by a previous `resolveSourceToCss()` call.
 * Safe to call on data URLs or gradients — only `blob:` URLs are revoked.
 */
export function disposeUrl(css: string): void {
  // The CSS we returned looks like `url('blob:...')` — extract and revoke.
  const m = /url\('?(blob:[^')]+)'?\)/.exec(css)
  if (m && m[1]) URL.revokeObjectURL(m[1])
}

/** Remove a wallpaper from the underlying store. Idempotent. */
export async function deleteImage(source: WallpaperSource): Promise<void> {
  if (source.kind !== "image") return
  if (source.storage === "data-url") return
  if (source.storage === "disk") {
    if (!isTauri()) return
    await invoke<void>("wallpaper_delete", { fileName: source.relPath }).catch(() => {
      // Idempotent — non-fatal so a missing file doesn't trap the user.
    })
    return
  }
  await idbDelete(source.blobKey).catch(() => {
    // Same rationale as above.
  })
}

/** Build a fresh `Wallpaper` row (id-only); the source must be filled in. */
export function makeWallpaper(args: {
  id: string
  name: string
  source: WallpaperSource
  builtin?: boolean
  createdAt?: number
}): Wallpaper {
  return {
    id: args.id,
    name: args.name,
    kind: args.source.kind,
    source: args.source,
    builtin: args.builtin ?? false,
    createdAt: args.createdAt ?? Date.now(),
  }
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
//
// We use the raw IDB API (rather than Dexie) because we only need a
// single-store key/value table for blobs and don't want to bump Dexie's
// schema version for this. Errors propagate as exceptions so callers can
// fall back to an in-memory data URL if the user has IDB disabled.
// ---------------------------------------------------------------------------

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) {
        db.createObjectStore(INDEXEDDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("idb open failed"))
  })
}

async function idbPut(key: string, blob: Blob): Promise<void> {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INDEXEDDB_STORE, "readwrite")
    tx.objectStore(INDEXEDDB_STORE).put(blob, key)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error ?? new Error("idb put failed"))
    }
  })
}

async function idbGet(key: string): Promise<Blob | null> {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INDEXEDDB_STORE, "readonly")
    const req = tx.objectStore(INDEXEDDB_STORE).get(key)
    req.onsuccess = () => {
      db.close()
      resolve((req.result as Blob | undefined) ?? null)
    }
    req.onerror = () => {
      db.close()
      reject(req.error ?? new Error("idb get failed"))
    }
  })
}

async function idbDelete(key: string): Promise<void> {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INDEXEDDB_STORE, "readwrite")
    tx.objectStore(INDEXEDDB_STORE).delete(key)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error ?? new Error("idb delete failed"))
    }
  })
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so the test file can exercise them directly)
// ---------------------------------------------------------------------------

export function mimeToExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png"
    case "image/jpeg":
    case "image/jpg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    case "image/avif":
      return "avif"
    case "image/svg+xml":
      return "svg"
    default:
      return "bin"
  }
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Avoid `btoa(String.fromCharCode(...))` for large buffers — the spread
  // pattern blows the call-stack on inputs >100 KB. Chunked encode keeps
  // the function safe for the full 32 MB cap.
  const view = new Uint8Array(buf)
  let bin = ""
  const chunk = 0x8000
  for (let i = 0; i < view.length; i += chunk) {
    const slice = view.subarray(i, i + chunk)
    bin += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  // `btoa` is stable in browsers, jsdom, and Tauri's webview.
  return typeof btoa === "function"
    ? btoa(bin)
    : // Node fallback used by tests that don't ship `btoa`. Buffer is fine
      // because Jest's runtime exposes it.
      Buffer.from(bin, "binary").toString("base64")
}
