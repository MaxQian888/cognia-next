"use client"

import { Suspense } from "react"

import { DeviceConsole } from "@/components/devices/device-console"
import { DevicesMobileBody } from "@/components/mobile/devices/devices-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

/**
 * `/devices`, the device and runtime console.
 *
 * Thin by design: the route owns nothing but which body to mount. The compact
 * branch is not a smaller console but an inverted one. On a phone the fleet
 * list IS the page and the detail arrives as a drawer, where `FeaturePageShell`
 * would have put the list behind a Sheet trigger.
 *
 * Both bodies read `useSearchParams()` (the `?device=` deep link that ⌘K and
 * Settings hand over, and `?addHost=` from `/servers`). The static export
 * pre-renders this page server-side, where that hook throws unless a Suspense
 * boundary lets it bail out to client rendering.
 */
export default function DevicesPage() {
  const compact = useCompactLayout()
  return <Suspense fallback={null}>{compact ? <DevicesMobileBody /> : <DeviceConsole />}</Suspense>
}
