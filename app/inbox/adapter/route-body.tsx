"use client"

/**
 * /inbox/adapter?adapterId=… — per-adapter inbox view.
 *
 * Static route reading the adapter id from the query string (replaces the old
 * `/inbox/adapter/[adapterId]` dynamic route, unservable for runtime ids under
 * `output: "export"`).
 *
 * Compact layouts get the phone-native `MobileInboxBody`, scoped to the
 * adapter. This route used to render the desktop shell at every width, so a
 * phone that followed a section or sidebar link landed outside the mobile
 * inbox. The native mobile build resolves `route-body.mobile.tsx` instead.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { MobileInboxBody } from "@/components/mobile/inbox/mobile-inbox-body"
import { PageLoading } from "@/components/ui/loading-states"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

function AdapterInboxInner() {
  const adapterId = useSearchParams().get("adapterId") ?? undefined
  const compact = useCompactLayout()
  return compact ? (
    <MobileInboxBody initialTab="messages" adapterId={adapterId} />
  ) : (
    <InboxShell view="by-adapter" adapterId={adapterId} />
  )
}

export default function AdapterInboxPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AdapterInboxInner />
    </Suspense>
  )
}
