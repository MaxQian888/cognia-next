"use client"

/**
 * BranchNavigator — prev/next arrow pair for switching between siblings.
 *
 * Two things produce siblings: regenerating an assistant reply, and editing a
 * user message (which keeps the original rather than deleting its tail). The
 * navigator is role-agnostic — it works off `metadata.branchGroupId` — and is
 * mounted on both roles.
 *
 * Reads `activeBranchByGroup` from the chat store, locates siblings via
 * `selectBranchSiblings`, and dispatches `setSessionActiveBranch`. Hidden when
 * the message has no group or the group has a single member.
 */

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { useChatStore, selectBranchSiblings } from "@/stores/chat/chat-store"
import { cn } from "@/lib/utils"
import type { UIMessage } from "ai"
import { setSessionActiveBranchSelection } from "@/lib/db/sessions"

interface BranchNavigatorProps {
  message: UIMessage
  className?: string
}

const NO_SIBLINGS: UIMessage[] = []

export function BranchNavigator({ message, className }: BranchNavigatorProps) {
  const t = useTranslations("chat.branchNavigator")
  const meta = message.metadata as { branchGroupId?: string; sessionId?: string } | undefined
  const groupId = meta?.branchGroupId
  // The session this message belongs to, which is NOT necessarily the focused
  // one — a split pane or a sidechat renders its own thread. Reading the
  // top-level projection here flipped branches against whatever happened to be
  // in front instead of the pane the arrows are in.
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessionId = typeof meta?.sessionId === "string" ? meta.sessionId : activeSessionId
  // Subscribe to the message COUNT, not the array: this navigator mounts in
  // every row, and the array ref swaps on every streamed token frame. Branch
  // siblings only change when a message lands or is removed (regenerations and
  // edits stamp their branch metadata together with a fresh message), so the
  // count is a sufficient — and O(1)-per-store-set — signal.
  const messageCount = useChatStore((s) => {
    if (!groupId) return 0
    const slice = sessionId ? s.sessions[sessionId] : undefined
    return slice ? slice.messages.length : s.messages.length
  })
  const activeId = useChatStore((s) => {
    if (!groupId) return undefined
    const slice = sessionId ? s.sessions[sessionId] : undefined
    return (slice ? slice.activeBranchByGroup : s.activeBranchByGroup)[groupId]
  })
  const setSessionActiveBranch = useChatStore((s) => s.setSessionActiveBranch)
  const setActiveBranch = useChatStore((s) => s.setActiveBranch)

  const siblings = useMemo(() => {
    if (!groupId) return NO_SIBLINGS
    const state = useChatStore.getState()
    const slice = sessionId ? state.sessions[sessionId] : undefined
    return selectBranchSiblings(slice ? slice.messages : state.messages, groupId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messageCount keys the getState() read above
  }, [messageCount, groupId, sessionId])

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
    if (!target) return
    // `sessionId` is null only before a session exists (the pre-session
    // ephemeral chat the store's top-level projection stands in for).
    if (sessionId) {
      setSessionActiveBranch(sessionId, groupId, target.id)
      void setSessionActiveBranchSelection(sessionId, groupId, target.id)
    } else setActiveBranch(groupId, target.id)
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
        title={t("prevBranch")}
        aria-label={t("prevBranch")}
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
        title={t("nextBranch")}
        aria-label={t("nextBranch")}
        data-testid="branch-navigator-next"
        onClick={() => goTo(currentIndex + 1)}
      >
        <ChevronRightIcon className="size-3.5" />
      </Button>
    </div>
  )
}

export default BranchNavigator
