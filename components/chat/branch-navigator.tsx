"use client"

/**
 * BranchNavigator — prev/next arrow pair for switching between assistant
 * regenerations. Reads `activeBranchByGroup` from the chat store, locates
 * siblings via `selectBranchSiblings`, and dispatches `setActiveBranch`.
 *
 * Hidden when the message has no `metadata.branchGroupId` or when only one
 * branch exists in the group.
 */

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { useChatStore, selectBranchSiblings } from "@/stores/chat/chat-store"
import { cn } from "@/lib/utils"
import type { UIMessage } from "ai"

interface BranchNavigatorProps {
  message: UIMessage
  className?: string
}

export function BranchNavigator({ message, className }: BranchNavigatorProps) {
  const groupId = (message.metadata as { branchGroupId?: string } | undefined)?.branchGroupId
  const messages = useChatStore((s) => s.messages)
  const activeId = useChatStore((s) => (groupId ? s.activeBranchByGroup[groupId] : undefined))
  const setActiveBranch = useChatStore((s) => s.setActiveBranch)

  const siblings = useMemo(
    () => (groupId ? selectBranchSiblings(messages, groupId) : []),
    [messages, groupId]
  )

  if (!groupId || siblings.length <= 1) return null

  const currentIndex = (() => {
    if (activeId) {
      const idx = siblings.findIndex((m) => m.id === activeId)
      if (idx >= 0) return idx
    }
    // No explicit choice — assume the highest index is active.
    return siblings.length - 1
  })()

  const goTo = (nextIdx: number) => {
    const wrapped = ((nextIdx % siblings.length) + siblings.length) % siblings.length
    const target = siblings[wrapped]
    if (target) setActiveBranch(groupId, target.id)
  }

  return (
    <div
      data-testid="branch-navigator"
      data-group-id={groupId}
      data-current-index={currentIndex}
      data-total={siblings.length}
      className={cn("inline-flex items-center gap-1", className)}
    >
      <Button
        size="icon-sm"
        variant="ghost"
        type="button"
        title="Previous branch"
        aria-label="Previous branch"
        data-testid="branch-navigator-prev"
        onClick={() => goTo(currentIndex - 1)}
      >
        <ChevronLeftIcon className="size-3.5" />
      </Button>
      <span
        className="font-mono text-xs tabular-nums text-muted-foreground"
        data-testid="branch-navigator-counter"
      >
        {currentIndex + 1} / {siblings.length}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        type="button"
        title="Next branch"
        aria-label="Next branch"
        data-testid="branch-navigator-next"
        onClick={() => goTo(currentIndex + 1)}
      >
        <ChevronRightIcon className="size-3.5" />
      </Button>
    </div>
  )
}

export default BranchNavigator
