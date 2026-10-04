"use client"

import { Suspense } from "react"
import { PageLoading } from "@/components/ui/loading-states"
import { MobileInboxBody } from "@/components/mobile/inbox/mobile-inbox-body"

export default function RouteBody() {
  return (
    <Suspense fallback={<PageLoading />}>
      <MobileInboxBody initialTab="messages" />
    </Suspense>
  )
}
