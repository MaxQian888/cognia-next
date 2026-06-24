"use client"

/**
 * Boot-time system-font enumeration.
 *
 * The webview can't list installed fonts, so on desktop we ask the Rust
 * `os_list_fonts` command once and push the result into the font registry
 * (`setSystemFonts`). The appearance + terminal font pickers then offer
 * real, installed families instead of only the web-safe baseline.
 *
 * Best-effort and idempotent: web mode is a no-op, failures leave the
 * registry untouched (and allow a later retry), and only the first
 * successful call hits the backend.
 */

import { isTauri } from "@/lib/tauri"
import { setSystemFonts, type SystemFontInfo } from "./font-registry"

export interface LoadSystemFontsDeps {
  /** Platform gate — injected for tests. Defaults to `isTauri`. */
  isDesktop?: () => boolean
  /** Tauri invoke — injected for tests. */
  invoke?: (cmd: string) => Promise<unknown>
}

let loaded = false

/** Enumerate installed fonts (desktop only) into the font registry. */
export async function loadSystemFonts(deps: LoadSystemFontsDeps = {}): Promise<void> {
  const isDesktop = deps.isDesktop ?? isTauri
  if (!isDesktop() || loaded) return
  loaded = true
  try {
    const invoke =
      deps.invoke ??
      (async (cmd: string) => {
        const core = await import("@tauri-apps/api/core")
        return core.invoke(cmd)
      })
    const result = await invoke("os_list_fonts")
    if (Array.isArray(result)) {
      setSystemFonts(result as SystemFontInfo[])
    }
  } catch {
    // Leave the registry at its web-safe baseline and allow a retry later.
    loaded = false
  }
}

/** Test-only: reset the once-per-session guard. */
export function __resetLoadSystemFontsForTesting(): void {
  loaded = false
}
