"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { PageLoading } from "@/components/ui/loading-states"
import { MobileInboxBody } from "@/components/mobile/inbox/mobile-inbox-body"

function AdapterInboxInner() {
  const adapterId = useSearchParams().get("adapterId") ?? undefined
  return <MobileInboxBody initialTab="messages" adapterId={adapterId} />
}

export default function RouteBody() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AdapterInboxInner />
    </Suspense>
  )
}
