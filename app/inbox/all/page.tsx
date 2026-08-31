"use client"

/**
 * /inbox/all — unified inbox view.
 *
 * Renders the InboxShell in "all" mode (no adapter/platform scoping).
 */

import { Suspense } from "react"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { MobileInboxBody } from "@/components/mobile/inbox/mobile-inbox-body"
import { PageLoading } from "@/components/ui/loading-states"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export default function InboxAllPage() {
  const compact = useCompactLayout()
  return (
    <Suspense fallback={<PageLoading />}>
      {compact ? <MobileInboxBody initialTab="messages" /> : <InboxShell view="all" />}
    </Suspense>
  )
}
