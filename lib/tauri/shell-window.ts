"use client"

/**
 * Thin TS wrapper around the `set_window_background_color` Tauri command.
 * Used by the renderer-side TauriProvider to keep the desktop window's
 * background colour aligned with the active appearance palette so the
 * custom titlebar (decorations=false on Windows) repaints in lockstep with
 * the in-app theme.
 *
 * No-op on web / Capacitor builds — the underlying `invoke` would throw the
 * "tauri" global isn't present, so we early-return via `isTauri()`.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

const HEX_PATTERN = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

/**
 * Push a `#RRGGBB` or `#RRGGBBAA` colour to the desktop window. Returns a
 * boolean describing the outcome rather than throwing, because callers wire
 * this into theme-change effects where a failed paint should never break
 * rendering. The Rust side validates again; this client-side check trims
 * obvious typos before the IPC round-trip.
 */
export async function setWindowBackgroundColor(hex: string): Promise<boolean> {
  if (!isTauri()) return false
  if (!HEX_PATTERN.test(hex)) {
    console.warn("setWindowBackgroundColor: rejected invalid hex", hex)
    return false
  }
  try {
    await invoke("set_window_background_color", { hex })
    return true
  } catch (err) {
    console.warn("setWindowBackgroundColor failed", err)
    return false
  }
}
