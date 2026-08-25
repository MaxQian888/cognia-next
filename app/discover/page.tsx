"use client"

/**
 * Discover route — `/discover`.
 *
 * Dispatches to a desktop or mobile body via `usePlatform()`. Both bodies
 * consume `useDiscoverRouteState`, which calls `useSearchParams()` and
 * therefore requires a `<Suspense>` boundary (Next.js 16 App Router rule).
 */

import { Suspense } from "react"

import { DiscoverDesktopBody } from "@/components/discover/discover-desktop-body"
import { DiscoverMobileBody } from "@/components/mobile/discover/discover-mobile-body"
import { usePlatform } from "@/hooks/use-platform"

export default function DiscoverPage() {
  return (
    <Suspense fallback={null}>
      <DiscoverPageBody />
    </Suspense>
  )
}

function DiscoverPageBody() {
  const platform = usePlatform()
  if (platform === "mobile") return <DiscoverMobileBody />
  return (
    <div className="h-full w-full min-h-0 flex-1">
      <DiscoverDesktopBody />
    </div>
  )
}
