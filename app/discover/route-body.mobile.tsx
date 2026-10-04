"use client"

import { Suspense } from "react"
import { DiscoverMobileBody } from "@/components/mobile/discover/discover-mobile-body"

export default function RouteBody() {
  return (
    <Suspense fallback={null}>
      <DiscoverMobileBody />
    </Suspense>
  )
}
