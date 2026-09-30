"use client"

import {
  dataUrlToBase64,
  isMobile,
  makeDefaultLoader,
  readFileAsDataUrl,
  type ValueOutcome,
} from "./_shared"
import { writeFile } from "./filesystem"

/**
 * `@capacitor/share` wrapper. Surfaces the system share sheet for the chat
 * forward menu (Wave 2) and per-message export. Falls back to navigator.share
 * on web when available.
 */

interface ShareShape {
  share(opts: {
    title?: string
    text?: string
    url?: string
    files?: string[]
    dialogTitle?: string
  }): Promise<{ activityType?: string }>
  canShare(): Promise<{ value: boolean }>
}

export type ShareLoader = () => Promise<ShareShape>

const defaultLoader: ShareLoader = makeDefaultLoader<ShareShape>("@capacitor/share", "Share")

export interface ShareOptions {
  title?: string
  text?: string
  url?: string
  files?: string[]
  dialogTitle?: string
  loader?: ShareLoader
}

export type ShareOutcome =
  | { kind: "shared"; activityType?: string }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export async function share(opts: ShareOptions): Promise<ShareOutcome> {
  const { title, text, url, files, dialogTitle, loader = defaultLoader } = opts

  // Try native plugin first.
  try {
    const plugin = await loader()
    try {
      const can = await plugin.canShare()
      if (!can.value) {
        return webShareFallback({ title, text, url })
      }
      const result = await plugin.share({ title, text, url, files, dialogTitle })
      return { kind: "shared", activityType: result.activityType }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/cancel/i.test(msg)) return { kind: "cancelled" }
      return { kind: "error", message: msg }
    }
  } catch {
    return webShareFallback({ title, text, url })
  }
}

async function webShareFallback(opts: {
  title?: string
  text?: string
  url?: string
}): Promise<ShareOutcome> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share(opts)
      return { kind: "shared" }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/abort|cancel/i.test(msg)) return { kind: "cancelled" }
      return { kind: "error", message: msg }
    }
  }
  return { kind: "unsupported" }
}

/** Writes one shared file into the app cache and returns its native `file://` URI. */
export type ShareCacheWriter = (
  path: string,
  base64: string
) => Promise<ValueOutcome<{ uri: string }>>

const defaultCacheWriter: ShareCacheWriter = (path, base64) =>
  writeFile({ path, data: base64, directory: "cache", encoding: "base64", recursive: true })

export interface ShareContentOptions {
  title?: string
  text?: string
  url?: string
  /** In-memory files (e.g. decoded screenshots, an export). */
  files?: File[]
  dialogTitle?: string
  loader?: ShareLoader
  /** Test seam for the cache write on mobile. */
  writeCacheFile?: ShareCacheWriter
  /** Test seam for the Web Share API. */
  nav?: Navigator
}

/** Keep a file name safe to use as a single cache path segment. */
function cacheFileName(name: string, index: number): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, "_").trim() || `file-${index + 1}`
  return `share/${index + 1}-${safe}`
}

/**
 * Hand text and/or in-memory files to the platform share surface.
 *
 * - Capacitor (native mobile): the WebView has no `navigator.share`, and the
 *   native Share plugin only takes file URIs — so each `File` is written into
 *   the app cache (exposed through the manifest's FileProvider `cache-path`)
 *   and the resulting URIs go to the system share sheet.
 * - Web / Tauri: the Web Share API, with files only when `canShare` accepts
 *   them. A file share the browser can't perform reports `unsupported` so the
 *   caller can fall back (e.g. to the clipboard) rather than silently dropping
 *   the attachments.
 */
export async function shareContent(opts: ShareContentOptions): Promise<ShareOutcome> {
  const { title, text, url, files = [], dialogTitle, loader } = opts

  if (isMobile()) {
    const writeCacheFile = opts.writeCacheFile ?? defaultCacheWriter
    const uris: string[] = []
    for (const [index, file] of files.entries()) {
      let base64: string
      try {
        base64 = dataUrlToBase64(await readFileAsDataUrl(file))
      } catch (err: unknown) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) }
      }
      const written = await writeCacheFile(cacheFileName(file.name, index), base64)
      if (written.kind === "unsupported") return { kind: "unsupported" }
      if (written.kind === "error") return { kind: "error", message: written.message }
      uris.push(written.value.uri)
    }
    return share({
      title,
      text,
      url,
      ...(uris.length > 0 ? { files: uris } : {}),
      dialogTitle,
      loader,
    })
  }

  const nav = opts.nav ?? (typeof navigator !== "undefined" ? navigator : undefined)
  if (!nav || typeof nav.share !== "function") return { kind: "unsupported" }
  const data: ShareData = {
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(url ? { url } : {}),
  }
  if (files.length > 0) {
    if (typeof nav.canShare !== "function" || !nav.canShare({ files })) {
      return { kind: "unsupported" }
    }
    data.files = files
  }
  try {
    await nav.share(data)
    return { kind: "shared" }
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name
    const msg = err instanceof Error ? err.message : String(err)
    if (name === "AbortError" || /abort|cancel/i.test(msg)) return { kind: "cancelled" }
    return { kind: "error", message: msg }
  }
}
