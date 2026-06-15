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
import { usePlatform } from "@/hooks/use-platform"

export default function InboxAllPage() {
  const platform = usePlatform()
  return (
    <Suspense fallback={<PageLoading />}>
      {platform === "mobile" ? (
        <MobileInboxBody initialTab="messages" />
      ) : (
        <InboxShell view="all" />
      )}
    </Suspense>
  )
}
