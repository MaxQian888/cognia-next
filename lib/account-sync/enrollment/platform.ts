/** Which kind of device this shell is, as the registry records it. */

import type { DevicePlatform } from "@cognia/sync-protocol"

import { isCapacitor, isTauri } from "@/lib/tauri"

export function currentDevicePlatform(): DevicePlatform {
  if (isTauri()) return "desktop"
  if (typeof isCapacitor === "function" && isCapacitor()) return "mobile"
  return "web"
}
