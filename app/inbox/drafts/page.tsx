"use client"

/**
 * /inbox/drafts — cross-conversation Draft Approval Center.
 *
 * Renders the InboxShell in "all" mode with the DraftCenter as the detail-pane
 * content so the operator keeps the sidebar + conversation list while reviewing
 * every pending draft in one queue.
 */

import { Suspense } from "react"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { DraftCenter } from "@/components/inbox/draft-center"
import { MobileInboxBody } from "@/components/mobile/inbox/mobile-inbox-body"
import { PageLoading } from "@/components/ui/loading-states"
import { usePlatform } from "@/hooks/use-platform"

export default function InboxDraftsPage() {
  const platform = usePlatform()
  return (
    <Suspense fallback={<PageLoading />}>
      {platform === "mobile" ? (
        <MobileInboxBody initialTab="drafts" />
      ) : (
        <InboxShell view="all">
          <DraftCenter />
        </InboxShell>
      )}
    </Suspense>
  )
}
