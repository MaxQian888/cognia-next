"use client"

/**
 * /inbox/platform?kind=… — per-platform inbox view.
 *
 * Static route reading the platform kind from the query string (replaces the
 * old `/inbox/platform/[kind]` dynamic route, unservable for runtime values
 * under `output: "export"`). Reached from the sidebar's platform grouping and
 * from a platform section header's scope link.
 *
 * Compact layouts get the phone-native `MobileInboxBody`, scoped to the
 * platform; the native mobile build resolves `route-body.mobile.tsx` instead.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { MobileInboxBody } from "@/components/mobile/inbox/mobile-inbox-body"
import { PageLoading } from "@/components/ui/loading-states"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

function PlatformInboxInner() {
  const kind = useSearchParams().get("kind") ?? undefined
  const compact = useCompactLayout()
  return compact ? (
    <MobileInboxBody initialTab="messages" platformKind={kind} />
  ) : (
    <InboxShell view="by-platform" platformKind={kind} />
  )
}

export default function PlatformInboxPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PlatformInboxInner />
    </Suspense>
  )
}
