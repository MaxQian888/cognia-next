"use client"

import { makeDefaultLoader, withPlugin, type ValueOutcome } from "./_shared"

/**
 * `@capacitor/device` wrapper. Surfaces detailed hardware / OS metadata for the
 * `/me/device-info` readout. Every field is optional because the native plugin
 * fills in different subsets per platform (e.g. `memUsed` / disk figures are
 * Android-richer, `webViewVersion` is empty on some iOS builds) and the
 * battery / language sub-calls are best-effort — a missing one must never sink
 * the whole read.
 *
 * On web / Tauri the dynamic import collapses to `{ kind: "unsupported" }` via
 * `withPlugin`, exactly like the sibling wrappers, and the card falls back to
 * the `navigator`-derived figures it can read in any shell.
 */

export interface DeviceDetails {
  /** Marketing / hardware model, e.g. "iPhone15,2" or "Pixel 8". */
  model?: string
  /** `"ios" | "android" | "web"`. */
  platform?: string
  /** OS family, e.g. "ios", "android". */
  operatingSystem?: string
  /** OS version string, e.g. "17.4". */
  osVersion?: string
  /** Device manufacturer, e.g. "Apple", "Google". */
  manufacturer?: string
  /** True on emulators / simulators. */
  isVirtual?: boolean
  /** Embedded WebView version. */
  webViewVersion?: string
  /** Bytes of memory currently in use by the app. */
  memUsed?: number
  /** Bytes of real free disk space. */
  realDiskFree?: number
  /** Bytes of real total disk space. */
  realDiskTotal?: number
  /** Battery charge 0..1. */
  batteryLevel?: number
  /** True while charging. */
  isCharging?: boolean
  /** Two-letter device language code, e.g. "en". */
  languageCode?: string
}

interface DeviceInfoRaw {
  model: string
  platform: string
  operatingSystem: string
  osVersion: string
  manufacturer: string
  isVirtual: boolean
  webViewVersion: string
  memUsed?: number
  realDiskFree?: number
  realDiskTotal?: number
}

interface BatteryInfoRaw {
  batteryLevel?: number
  isCharging?: boolean
}

interface DeviceShape {
  getInfo(): Promise<DeviceInfoRaw>
  getBatteryInfo(): Promise<BatteryInfoRaw>
  getLanguageCode(): Promise<{ value: string }>
}

export type DeviceLoader = () => Promise<DeviceShape>

const defaultLoader: DeviceLoader = makeDefaultLoader<DeviceShape>("@capacitor/device", "Device")

/**
 * Read the full device profile. `getInfo` is required; the battery and
 * language sub-calls are wrapped in their own try/catch so a plugin that
 * omits them (or throws on an unsupported platform) still yields the core
 * hardware fields rather than collapsing to `error`.
 */
export async function getDeviceInfo(
  loader: DeviceLoader = defaultLoader
): Promise<ValueOutcome<DeviceDetails>> {
  return withPlugin(loader, async (d) => {
    const info = await d.getInfo()

    let battery: BatteryInfoRaw = {}
    try {
      battery = await d.getBatteryInfo()
    } catch {
      // Battery readout is best-effort — keep the hardware fields.
    }

    let languageCode: string | undefined
    try {
      languageCode = (await d.getLanguageCode()).value
    } catch {
      // Language code is best-effort.
    }

    return {
      kind: "ok" as const,
      value: {
        model: info.model,
        platform: info.platform,
        operatingSystem: info.operatingSystem,
        osVersion: info.osVersion,
        manufacturer: info.manufacturer,
        isVirtual: info.isVirtual,
        webViewVersion: info.webViewVersion,
        memUsed: info.memUsed,
        realDiskFree: info.realDiskFree,
        realDiskTotal: info.realDiskTotal,
        batteryLevel: battery.batteryLevel,
        isCharging: battery.isCharging,
        languageCode,
      },
    }
  })
}
