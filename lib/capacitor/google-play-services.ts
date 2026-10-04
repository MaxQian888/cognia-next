"use client"

import { asNonThenable } from "./_shared"

interface DeviceServicesPlugin {
  getStatus(): Promise<unknown>
}

export type GooglePlayServicesLoader = () => Promise<DeviceServicesPlugin>
export type GooglePlayServicesStatus =
  { available: boolean; status: number } | { available: false; status: "unknown" }

const defaultLoader: GooglePlayServicesLoader = async () => {
  // This is an app-local Android plugin, without an npm package or web shim.
  // registerNativePlugins creates its proxy from the native PluginHeaders.
  const plugin = (
    globalThis as unknown as {
      Capacitor?: { Plugins?: { CogniaDeviceServices?: DeviceServicesPlugin } }
    }
  ).Capacitor?.Plugins?.CogniaDeviceServices
  if (!plugin) throw new Error("CogniaDeviceServices is unavailable")
  return asNonThenable(plugin)
}

/** Check silently on every scan, since system services may have changed since boot. */
export async function getGooglePlayServicesStatus(
  loader: GooglePlayServicesLoader = defaultLoader
): Promise<GooglePlayServicesStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(async () => (await loader()).getStatus()),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 2_000)
      }),
    ])
    if (typeof result === "object" && result !== null && "status" in result) {
      const status = result.status
      if (typeof status === "number" && Number.isInteger(status) && status >= 0) {
        return { available: status === 0, status }
      }
    }
    return { available: false, status: "unknown" }
  } catch {
    return { available: false, status: "unknown" }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
