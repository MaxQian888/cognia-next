"use client"

/**
 * Discover route — `/discover`.
 *
 * Dispatches to a desktop or compact body by viewport width (`useCompactLayout`,
 * which is also pinned true on a native mobile shell). Both bodies
 * consume `useDiscoverRouteState`, which calls `useSearchParams()` and
 * therefore requires a `<Suspense>` boundary (Next.js 16 App Router rule).
 */

import { Suspense } from "react"

import { DiscoverDesktopBody } from "@/components/discover/discover-desktop-body"
import { DiscoverMobileBody } from "@/components/mobile/discover/discover-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export default function DiscoverPage() {
  return (
    <Suspense fallback={null}>
      <DiscoverPageBody />
    </Suspense>
  )
}

function DiscoverPageBody() {
  const compact = useCompactLayout()
  if (compact) return <DiscoverMobileBody />
  return (
    <div className="h-full w-full min-h-0 flex-1">
      <DiscoverDesktopBody />
    </div>
  )
}
