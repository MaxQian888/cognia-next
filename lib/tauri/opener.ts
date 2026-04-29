"use client"

import {
  openUrl as openUrlNative,
  openPath as openPathNative,
  revealItemInDir as revealNative,
} from "@tauri-apps/plugin-opener"
import { isTauri } from "@/lib/tauri"

/**
 * Open an external URL in the user's default browser. Falls back to
 * `window.open` in web mode.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await openUrlNative(url)
    return
  }
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer")
}

/**
 * Open a local path in its default associated app (e.g. a `.md` file in the
 * default markdown editor). Tauri-only; no-op in browser.
 */
export async function openPath(path: string): Promise<void> {
  if (!isTauri()) return
  await openPathNative(path)
}

/**
 * Reveal a file or folder in the OS file explorer (Finder on macOS,
 * Explorer on Windows, default file manager on Linux). Tauri-only.
 */
export async function revealInExplorer(path: string): Promise<void> {
  if (!isTauri()) return
  await revealNative(path)
}
