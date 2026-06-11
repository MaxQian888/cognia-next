"use client"

import { isTauri } from "@/lib/tauri"

/**
 * Thin wrapper around `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`,
 * mirroring `lib/tauri/autostart.ts`. Three surfaces consume the updater — the
 * Settings → About card, the command palette, and the boot-time auto-check
 * initializer — so the `check()` / `downloadAndInstall()` / `relaunch()` dance
 * lives here once instead of being inlined at each call site.
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
 * Check the configured endpoint for a newer release. Resolves to the available
 * update (version + notes) or `null` when already current. No-op (→ `null`)
 * off the desktop shell. Throws on a network / endpoint failure so callers can
 * surface their own error toast.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri()) return null
  const { check } = await import("@tauri-apps/plugin-updater")
  const update = await check()
  if (!update) return null
  return { version: update.version, body: update.body }
}

/** Outcome of {@link downloadAndInstallUpdate}. */
export type InstallUpdateResult = "installed" | "noLongerAvailable" | "web"

/**
 * Re-check (so a stale "available" state can't install a pulled release), then
 * download + install the pending update and relaunch the app. Returns:
 * - `"installed"` — installed; `relaunch()` has been requested.
 * - `"noLongerAvailable"` — the update vanished between check and install.
 * - `"web"` — called off the desktop shell.
 * Throws on a download / install failure so callers can surface a toast.
 */
export async function downloadAndInstallUpdate(): Promise<InstallUpdateResult> {
  if (!isTauri()) return "web"
  const { check } = await import("@tauri-apps/plugin-updater")
  const update = await check()
  if (!update) return "noLongerAvailable"
  await update.downloadAndInstall()
  const { relaunch } = await import("@tauri-apps/plugin-process")
  await relaunch()
  return "installed"
}
