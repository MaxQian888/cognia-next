"use client"

import { getDeviceInfo } from "./device"
import { makeDefaultLoader, withPlugin, type SimpleOutcome, type ValueOutcome } from "./_shared"

/**
 * `@capacitor/screen-orientation` wrapper. Used by the mobile workflow canvas
 * editor (`components/mobile/workflow/editor/mobile-canvas.tsx`) to lock
 * landscape while editing the 2D node graph.
 */

export type OrientationType =
  "portrait-primary" | "portrait-secondary" | "landscape-primary" | "landscape-secondary"

export type OrientationLockType =
  | "any"
  | "natural"
  | "landscape"
  | "portrait"
  | "portrait-primary"
  | "portrait-secondary"
  | "landscape-primary"
  | "landscape-secondary"

interface ScreenOrientationShape {
  orientation(): Promise<{ type: OrientationType }>
  lock(opts: { orientation: OrientationLockType }): Promise<void>
  unlock(): Promise<void>
}

export type ScreenOrientationLoader = () => Promise<ScreenOrientationShape>

const defaultLoader: ScreenOrientationLoader = makeDefaultLoader<ScreenOrientationShape>(
  "@capacitor/screen-orientation",
  "ScreenOrientation"
)

export async function getOrientation(
  loader: ScreenOrientationLoader = defaultLoader
): Promise<ValueOutcome<OrientationType>> {
  const result = await withPlugin(loader, async (so) => {
    const r = await so.orientation()
    return { kind: "ok" as const, value: r.type }
  })
  return result
}

/** Current iPad builds retain multitasking; Android 16 large screens ignore locks. */
export async function getLockSupport(
  deviceInfo = getDeviceInfo,
  servicesLoader = makeDefaultLoader<{
    getOrientationLockSupport(): Promise<{ supported: boolean }>
  }>("cognia-device-services", "CogniaDeviceServices")
): Promise<ValueOutcome<boolean>> {
  const device = await deviceInfo()
  if (device.kind !== "ok") return device
  if (device.value.platform === "ios") {
    return { kind: "ok", value: !!device.value.model && !device.value.model.startsWith("iPad") }
  }
  if (device.value.platform !== "android") return { kind: "unsupported" }
  return withPlugin(servicesLoader, async (services) => ({
    kind: "ok" as const,
    value: (await services.getOrientationLockSupport()).supported === true,
  }))
}

export async function lock(
  orientation: OrientationLockType,
  loader: ScreenOrientationLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (so) => {
    await so.lock({ orientation })
    return { kind: "ok" as const }
  })
}

export async function unlock(
  loader: ScreenOrientationLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (so) => {
    await so.unlock()
    return { kind: "ok" as const }
  })
}
