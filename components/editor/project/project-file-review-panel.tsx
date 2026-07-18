"use client"

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ReviewHunkItem } from "@/components/artifacts/review-hunk-item"
import {
  applyProjectFileProposal,
  discardProjectFileProposal,
  getProjectFileProposal,
  rebaseProjectFileProposal,
  setProjectFileProposalItemStatus,
  subscribeProjectFileProposals,
  undoProjectFileProposal,
} from "@/lib/context-workbench/project-file-proposals"

export function ProjectFileReviewPanel({ resourceKey }: { resourceKey: string }) {
  const t = useTranslations("contextWorkbench.projectProposal")
  const proposal = useSyncExternalStore(
    subscribeProjectFileProposals,
    () => getProjectFileProposal(resourceKey),
    () => null
  )

  if (!proposal) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {t("empty")}
      </div>
    )
  }

  const accepted = proposal.review.items.filter((item) => item.status === "accepted").length
  const applied = proposal.review.status === "completed"
  return (
    <div className="flex h-full min-h-0 flex-col">
      {proposal.review.isStale ? (
        <div className="border-b bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {t("stale")}
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {proposal.review.items.map((item) => (
            <ReviewHunkItem
              key={item.id}
              item={item}
              disabled={proposal.review.isStale || applied}
              onAccept={(id) => setProjectFileProposalItemStatus(resourceKey, id, "accepted")}
              onReject={(id) => setProjectFileProposalItemStatus(resourceKey, id, "rejected")}
            />
          ))}
        </div>
      </ScrollArea>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t p-2">
        {applied ? (
          <Button size="sm" variant="outline" onClick={() => undoProjectFileProposal(resourceKey)}>
            {t("undo")}
          </Button>
        ) : proposal.review.isStale ? (
          <Button size="sm" onClick={() => rebaseProjectFileProposal(resourceKey)}>
            {t("rebase")}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => discardProjectFileProposal(resourceKey)}
            >
              {t("discard")}
            </Button>
            <Button
              size="sm"
              disabled={accepted === 0}
              onClick={() => applyProjectFileProposal(resourceKey)}
            >
              {t("apply")}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
