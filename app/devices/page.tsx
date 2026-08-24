"use client"

/**
 * `/devices` — the device and runtime console.
 *
 * Thin by design, like `app/servers/page.tsx`: the route owns nothing but the
 * mount point, so the console can also be rendered from the mobile shell
 * without dragging a second copy of the layout along.
 */

import { DeviceConsole } from "@/components/devices/device-console"

export default function DevicesPage() {
  return <DeviceConsole />
}
