"use client"

import { isTauri } from "@/lib/tauri"

/**
 * Thin wrapper around `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`,
 * mirroring `lib/tauri/autostart.ts`. Four surfaces consume the updater — the
 * Settings → About card, the command palette, the tray "Check for updates"
 * action, and the boot-time auto-check initializer — so the `check()` /
 * `downloadAndInstall()` / `relaunch()` dance lives here once instead of being
 * inlined at each call site.
 *
 * The plugin is pulled in via dynamic `import()` (not a static top-level import
 * like autostart) so the web + Capacitor bundles never resolve
 * `@tauri-apps/plugin-updater`, which has no business existing off the desktop
 * shell.
 */

/** Available update surfaced to the UI: the newer version plus its notes. */
export interface AvailableUpdate {
  version: string
  body?: string
}

/**
 * Minimal structural shape of the plugin's `Update` handle — enough to install
 * with a progress callback without statically importing the plugin's types.
 */
interface UpdateHandle {
  version: string
  body?: string
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>
}

/** The `downloadAndInstall` progress events emitted by the Tauri updater. */
type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" }

/** Download progress surfaced to the UI while an update is installing. */
export interface UpdateProgress {
  /** Bytes downloaded so far. */
  downloaded: number
  /** Total bytes, when the server sent a Content-Length (absent otherwise). */
  total?: number
}

/** Receives a {@link UpdateProgress} tick on each download event. */
export type UpdateProgressHandler = (progress: UpdateProgress) => void

/**
 * How long a cached {@link checkForUpdate} handle stays eligible for reuse by
 * {@link downloadAndInstallUpdate}. The cache exists for the immediate
 * "check, then click Install" flow (seconds to a couple of minutes). Because
 * the handle is shared across all four surfaces — including the 6-hour
 * auto-check and the tray — a handle written long ago could point at a release
 * that has since been superseded or pulled server-side; past this window we
 * re-check rather than install from a stale handle.
 */
const PENDING_UPDATE_TTL_MS = 10 * 60 * 1000

/**
 * The `Update` handle from the most recent {@link checkForUpdate}. Cached so the
 * common "check, then click Install" flow reuses the already-fetched handle
 * instead of paying a second network round-trip + signature parse in
 * {@link downloadAndInstallUpdate}. Cleared once the update is gone (check →
 * null) or installed, and ignored once older than {@link PENDING_UPDATE_TTL_MS}.
 */
let pendingUpdate: UpdateHandle | null = null
/** Wall-clock time {@link pendingUpdate} was last set; `0` when none is cached. */
let pendingUpdateAt = 0

/** Cache (or clear) the pending-update handle alongside its capture time. */
function cachePendingUpdate(update: UpdateHandle | null): void {
  pendingUpdate = update
  pendingUpdateAt = update ? Date.now() : 0
}

/**
 * Check the configured endpoint for a newer release. Resolves to the available
 * update (version + notes) or `null` when already current. No-op (→ `null`)
 * off the desktop shell. Throws on a network / endpoint failure so callers can
 * surface their own error toast. Side effect: caches the resolved handle for a
 * subsequent {@link downloadAndInstallUpdate} (or clears it when current).
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri()) return null
  const { check } = await import("@tauri-apps/plugin-updater")
  const update = (await check()) as UpdateHandle | null
  if (!update) {
    cachePendingUpdate(null)
    return null
  }
  cachePendingUpdate(update)
  return { version: update.version, body: update.body }
}

/** Outcome of {@link downloadAndInstallUpdate}. */
export type InstallUpdateResult = "installed" | "noLongerAvailable" | "web"

/**
 * Download + install the pending update and relaunch the app. Reuses the handle
 * cached by the preceding {@link checkForUpdate} (the common case from the About
 * card / command palette), falling back to a fresh `check()` when no handle is
 * cached or the cached one has aged past {@link PENDING_UPDATE_TTL_MS} (so a
 * release pulled/superseded since the cached check can't be installed from a
 * stale handle). Streams download progress to the optional `onProgress` callback so
 * the UI can show a bar — the bundled sidecar + node_modules make installers
 * large enough that silent installs look frozen. Returns:
 * - `"installed"` — installed; `relaunch()` has been requested.
 * - `"noLongerAvailable"` — no cached handle and a re-check found nothing.
 * - `"web"` — called off the desktop shell.
 * Throws on a download / install failure so callers can surface a toast.
 */
export async function downloadAndInstallUpdate(
  onProgress?: UpdateProgressHandler
): Promise<InstallUpdateResult> {
  if (!isTauri()) return "web"
  let handle = pendingUpdate
  if (handle && Date.now() - pendingUpdateAt > PENDING_UPDATE_TTL_MS) {
    // Cached handle is too old to trust — re-check so a superseded/pulled
    // release isn't installed from a stale check.
    handle = null
  }
  if (!handle) {
    const { check } = await import("@tauri-apps/plugin-updater")
    handle = (await check()) as UpdateHandle | null
    if (!handle) {
      cachePendingUpdate(null)
      return "noLongerAvailable"
    }
  }

  let downloaded = 0
  let total: number | undefined
  await handle.downloadAndInstall((event) => {
    if (!onProgress) return
    switch (event.event) {
      case "Started":
        total = event.data.contentLength
        downloaded = 0
        onProgress({ downloaded, total })
        break
      case "Progress":
        downloaded += event.data.chunkLength
        onProgress({ downloaded, total })
        break
      case "Finished":
        onProgress({ downloaded: total ?? downloaded, total })
        break
    }
  })
  cachePendingUpdate(null)

  const { relaunch } = await import("@tauri-apps/plugin-process")
  await relaunch()
  return "installed"
}

/** Test-only: clear the cached pending-update handle between cases. */
export function __resetPendingUpdate(): void {
  cachePendingUpdate(null)
}
