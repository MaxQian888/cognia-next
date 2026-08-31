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
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export default function InboxDraftsPage() {
  const compact = useCompactLayout()
  return (
    <Suspense fallback={<PageLoading />}>
      {compact ? (
        <MobileInboxBody initialTab="drafts" />
      ) : (
        <InboxShell view="all">
          <DraftCenter />
        </InboxShell>
      )}
    </Suspense>
  )
}
