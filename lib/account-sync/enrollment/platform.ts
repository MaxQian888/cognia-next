/** Which kind of device this shell is, as the registry records it. */

import type { DevicePlatform } from "@cognia/sync-protocol"

import { isCapacitor, isTauri } from "@/lib/tauri"

export function currentDevicePlatform(): DevicePlatform {
  if (isTauri()) return "desktop"
  if (typeof isCapacitor === "function" && isCapacitor()) return "mobile"
  return "web"
}

/**
 * A first guess at this device's name, from the operating system the user
 * agent names ("Mac", "iPhone"…). Product names, not prose, so they need no
 * translation; empty when nothing is recognized (the field stays blank).
 */
export function suggestDeviceName(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent
): string {
  if (/iPhone/.test(userAgent)) return "iPhone"
  if (/iPad/.test(userAgent)) return "iPad"
  if (/Android/.test(userAgent)) return "Android"
  if (/Mac OS X|Macintosh/.test(userAgent)) return "Mac"
  if (/Windows/.test(userAgent)) return "Windows"
  if (/CrOS/.test(userAgent)) return "Chromebook"
  if (/Linux/.test(userAgent)) return "Linux"
  return ""
}
