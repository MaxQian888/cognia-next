"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { PageLoading } from "@/components/ui/loading-states"
import { MobileInboxBody } from "@/components/mobile/inbox/mobile-inbox-body"

function PlatformInboxInner() {
  const kind = useSearchParams().get("kind") ?? undefined
  return <MobileInboxBody initialTab="messages" platformKind={kind} />
}

export default function RouteBody() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PlatformInboxInner />
    </Suspense>
  )
}
