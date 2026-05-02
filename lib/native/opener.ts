/**
 * URL / file opener used by the plugin devtools surface.
 *
 * In Tauri builds we route through `@tauri-apps/plugin-opener` so the OS
 * picks the right handler (browser for `https://`, file association for
 * paths). In web mode we fall back to `window.open` for URLs and a
 * download anchor for paths.
 */

import { isTauri } from "@/lib/tauri"

export interface OpenUrlOptions {
  /** Optional explicit application id (Tauri-only). */
  with?: string
  /** Force a fallback path even in Tauri (mostly useful in tests). */
  forceWebFallback?: boolean
}

export async function openUrl(url: string, options: OpenUrlOptions = {}): Promise<void> {
  if (!options.forceWebFallback && isTauri()) {
    try {
      const mod = await import("@tauri-apps/plugin-opener")
      await mod.openUrl(url)
      return
    } catch (err) {
      // Fall through to web fallback if the plugin isn't bundled.
      console.warn("openUrl: tauri opener failed, falling back to window.open", err)
    }
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer")
  }
}

export async function openPath(path: string, options: OpenUrlOptions = {}): Promise<void> {
  if (!options.forceWebFallback && isTauri()) {
    try {
      const mod = await import("@tauri-apps/plugin-opener")
      await mod.openPath(path)
      return
    } catch (err) {
      console.warn("openPath: tauri opener failed, falling back to window.open", err)
    }
  }

  if (typeof window !== "undefined") {
    // In a browser there's no good "open this file with the OS handler"
    // — we treat the path as a relative URL so the browser handles it.
    window.open(path, "_blank", "noopener,noreferrer")
  }
}
