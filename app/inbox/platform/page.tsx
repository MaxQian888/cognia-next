"use client"

/**
 * /inbox/platform?kind=… — per-platform inbox view.
 *
 * Static route reading the platform kind from the query string (replaces the
 * old `/inbox/platform/[kind]` dynamic route, unservable for runtime values
 * under `output: "export"`).
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { PageLoading } from "@/components/ui/loading-states"

function PlatformInboxInner() {
  const kind = useSearchParams().get("kind") ?? undefined
  return <InboxShell view="by-platform" platformKind={kind} data-testid="platform-inbox-shell" />
}

export default function PlatformInboxPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PlatformInboxInner />
    </Suspense>
  )
}
