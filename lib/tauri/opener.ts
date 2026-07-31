"use client"

import {
  openUrl as openUrlNative,
  openPath as openPathNative,
  revealItemInDir as revealNative,
} from "@tauri-apps/plugin-opener"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { open as openInAppBrowser } from "@/lib/capacitor/browser"

/**
 * Open an external URL in the user's default browser. On the Capacitor
 * shell this routes through `@capacitor/browser` (in-app browser sheet) —
 * `window.open`/`target="_blank"` is unreliable inside the mobile WebView
 * (Android blocks new-window creation, WKWebView behavior is inconsistent).
 * Falls back to `window.open` in plain web mode.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await openUrlNative(url)
    return
  }
  if (isCapacitor()) {
    const out = await openInAppBrowser({ url })
    if (out.kind === "ok") return
    // Plugin missing / failed — fall through to window.open as a last resort.
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
