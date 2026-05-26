"use client"

import { makeDefaultLoader, type SimpleOutcome, withPlugin } from "./_shared"

/**
 * Deep-link the user to this app's system Settings page.
 *
 * Recovery path for denied runtime permissions: once a user denies camera,
 * notifications, or location/mDNS there is no programmatic re-prompt, so the
 * only recovery is "前往设置开启权限". Used by the mDNS permission denial path
 * (Wave 4 / ADR-0026), the QR scanner camera-denied path, and the notification
 * permission CTA.
 *
 * Backed by `capacitor-native-settings` (`NativeSettings.open`):
 *   - Android: `Intent.ACTION_APPLICATION_DETAILS_SETTINGS` (`optionAndroid:
 *     "application_details"`) — the app's own permission screen.
 *   - iOS: `UIApplication.openSettingsURLString` (`optionIOS: "app"`), the only
 *     Apple-sanctioned settings deep-link.
 *
 * NOTE: `@capacitor/app` has **no** `openSettings()` method — the previous
 * implementation called a method that does not exist on the native plugin and
 * silently failed on-device (only its loader-injecting unit test passed).
 * `capacitor-native-settings` is the dedicated plugin for this.
 *
 * On web / Tauri the loader rejects → `{ kind: "unsupported" }` so the caller
 * can fall back to inline instructions.
 */

interface NativeSettingsShape {
  open(options: { optionAndroid: string; optionIOS: string }): Promise<{ status: boolean }>
}

export type AppSettingsLoader = () => Promise<NativeSettingsShape>

const defaultLoader: AppSettingsLoader = makeDefaultLoader<NativeSettingsShape>(
  "capacitor-native-settings",
  "NativeSettings"
)

// Raw enum string values from `capacitor-native-settings`
// (AndroidSettings.ApplicationDetails / IOSSettings.App). Passed as literals
// because the package is resolved at runtime via window.Capacitor.Plugins, not
// imported here (it is a mobile-workspace dep, absent from the root bundle).
const ANDROID_APPLICATION_DETAILS = "application_details"
const IOS_APP = "app"

export async function openAppSettings(
  loader: AppSettingsLoader = defaultLoader
): Promise<SimpleOutcome> {
  const result = await withPlugin(loader, async (plugin) => {
    await plugin.open({ optionAndroid: ANDROID_APPLICATION_DETAILS, optionIOS: IOS_APP })
    return { kind: "ok" as const }
  })
  return result as SimpleOutcome
}
