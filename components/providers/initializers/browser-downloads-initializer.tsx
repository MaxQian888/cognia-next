"use client"

/**
 * Keeps the desktop browser's download history (`browserDownloads`, ADR-0201)
 * fed for the app's lifetime, mounted inside `DesktopOnlyInitializers` (main
 * desktop window only).
 *
 * The feed used to be mounted by the browser pane, so a download an agent
 * started in a headless local-Chromium session (External Bridge, or a chat
 * with the pane closed) never reached Dexie: Rust emitted it with nobody
 * listening. Here one shared subscription (`acquireBrowserDownloadFeed`, ref
 * counted) folds the embedded webview's `browser://download` and the local
 * runtime's `download.updated` into the history whether or not a pane is open.
 * Off the desktop there is nothing to listen to, so it stays unmounted.
 */

import { useBrowserDownloadFeed } from "@/hooks/browser/use-browser-downloads"
import { isTauri } from "@/lib/native/utils"

export function BrowserDownloadsInitializer() {
  useBrowserDownloadFeed(isTauri())
  return null
}

export default BrowserDownloadsInitializer
