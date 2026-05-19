"use client"

import { makeDefaultLoader, type SimpleOutcome, withPlugin } from "./_shared"

/**
 * Deep-link the user to this app's system Settings page.
 *
 * Used by the mDNS permission denial path (Wave 4 / ADR-0026) and by the
 * QR scanner camera-denied path: once the user has denied a runtime
 * permission, there is no programmatic re-prompt on iOS, so the only
 * recovery is "前往设置开启权限".
 *
 * Maps to:
 *   - iOS: `App.openSettings()` → `UIApplication.openURL(UIApplication.openSettingsURLString)`
 *   - Android: `App.exitApp()` is wrong here; the upstream `@capacitor/app`
 *     plugin's `openSettings` invokes `Intent.ACTION_APPLICATION_DETAILS_SETTINGS`
 *     with the app's own package URI.
 *
 * On web / Tauri the call returns `{ kind: "unsupported" }` so the caller
 * can fall back to inline instructions.
 */

interface AppSettingsShape {
  openSettings(): Promise<void>
}

export type AppSettingsLoader = () => Promise<AppSettingsShape>

const defaultLoader: AppSettingsLoader = makeDefaultLoader<AppSettingsShape>(
  "@capacitor/app",
  "App"
)

export async function openAppSettings(
  loader: AppSettingsLoader = defaultLoader
): Promise<SimpleOutcome> {
  const result = await withPlugin(loader, async (plugin) => {
    await plugin.openSettings()
    return { kind: "ok" as const }
  })
  return result as SimpleOutcome
}
