"use client"

/**
 * /inbox/adapter?adapterId=… — per-adapter inbox view.
 *
 * Static route reading the adapter id from the query string (replaces the old
 * `/inbox/adapter/[adapterId]` dynamic route, unservable for runtime ids under
 * `output: "export"`).
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { PageLoading } from "@/components/ui/loading-states"

function AdapterInboxInner() {
  const adapterId = useSearchParams().get("adapterId") ?? undefined
  return <InboxShell view="by-adapter" adapterId={adapterId} data-testid="adapter-inbox-shell" />
}

export default function AdapterInboxPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AdapterInboxInner />
    </Suspense>
  )
}
