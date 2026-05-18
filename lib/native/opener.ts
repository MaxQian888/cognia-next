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
  // E2E hook: when the dev bridge has installed `__cogniaE2EOpenUrl`, route
  // the call through it instead of the OS browser. Specs use this to assert
  // an OAuth flow opened the right authorize URL without popping a real
  // browser window. Dead-code-eliminated in production builds because the
  // global is only ever populated under `NEXT_PUBLIC_E2E=1`.
  if (typeof window !== "undefined") {
    const w = window as { __cogniaE2EOpenUrl?: (url: string) => void }
    if (typeof w.__cogniaE2EOpenUrl === "function") {
      w.__cogniaE2EOpenUrl(url)
      return
    }
  }

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
