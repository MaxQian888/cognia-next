import { Suspense } from "react"

import { DeviceConsole } from "@/components/devices/device-console"

/**
 * `/devices` — the device and runtime console.
 *
 * Thin by design, like `app/servers/page.tsx`: the route owns nothing but the
 * mount point, so the console can also be rendered from the mobile shell
 * without a second copy of the layout.
 *
 * `DeviceConsole` reads `useSearchParams()` for the `?device=<ref>` deep link
 * that ⌘K and the Settings entry points hand it. The static export pre-renders
 * this page server-side, where that hook throws unless a Suspense boundary
 * lets it bail out to client rendering.
 */
export default function DevicesPage() {
  return (
    <Suspense fallback={null}>
      <DeviceConsole />
    </Suspense>
  )
}
