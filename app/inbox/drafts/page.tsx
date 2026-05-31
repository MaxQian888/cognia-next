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
import { PageLoading } from "@/components/ui/loading-states"

export default function InboxDraftsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <InboxShell view="all">
        <DraftCenter />
      </InboxShell>
    </Suspense>
  )
}
