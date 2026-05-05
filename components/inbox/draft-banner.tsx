"use client"

/**
 * Draft review banner — appears at the top of the conversation detail view
 * when a pending draft exists for the conversationKey.
 *
 * Click "Review" to open the DraftEditor inline.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { PenLineIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { getDb } from "@/lib/db/schema"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import { DraftEditor } from "./draft-editor"

interface DraftBannerProps {
  conversationKey: string
}

export function DraftBanner({ conversationKey }: DraftBannerProps) {
  const [open, setOpen] = useState(false)

  // Subscribe to pending drafts for this conversation.
  const pendingDrafts = useLiveQuery<ConnectorDraftRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb()
            .connectorDrafts.where("[conversationKey+createdAt]")
            .between([conversationKey, -Infinity], [conversationKey, Infinity])
            .filter((r) => r.status === "pending")
            .toArray(),
    [conversationKey]
  )

  const firstDraft = pendingDrafts?.[0]

  if (!firstDraft) return null

  return (
    <>
      <div
        className="flex items-center gap-3 border-b bg-amber-50 px-4 py-2 dark:bg-amber-950/30"
        data-testid="draft-banner"
      >
        <PenLineIcon className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <p className="flex-1 text-sm text-amber-800 dark:text-amber-300">
          A draft reply is waiting for your review.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          data-testid="draft-review-btn"
        >
          Review
        </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Review draft reply</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <DraftEditor draft={firstDraft} onClose={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
