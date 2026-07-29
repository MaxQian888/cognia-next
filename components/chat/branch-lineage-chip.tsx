"use client"

/**
 * "Branched from …" chip for a session created by {@link branchSessionAtMessage}.
 *
 * A branch inherits its parent's title plus a suffix, so two panes side by side
 * read almost identically and neither says which came first. The lineage is
 * already on the row (`parentSessionId` / `branchedFromMessageId`); this just
 * shows it, and makes it navigable.
 *
 * The sidebar's own branch indicator (`components/desktop/session-row.tsx`)
 * selects the parent session and stops there. This lands on the exact message
 * the branch was cut at, which is the question you actually have when comparing
 * two branches.
 *
 * Renders nothing for a session that is not a branch.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { GitBranchIcon } from "lucide-react"

import type { ChatSession } from "@cognia/agent-config-types"
import { getSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { cn } from "@/lib/utils"

export function BranchLineageChip({
  session,
  className,
}: {
  session: ChatSession
  className?: string
}) {
  const t = useTranslations("chat.branch")
  const parentId = session.parentSessionId ?? null
  const jumpToMessage = useChatViewportStore((s) => s.jumpToMessage)
  const parent = useLiveQuery(
    async () => (parentId ? ((await getSession(parentId)) ?? null) : null),
    [parentId]
  )

  if (!parentId) return null

  const label = t("lineage", { title: parent?.title || t("lineageUnknownParent") })

  const onJump = () => {
    const store = useChatStore.getState()
    store.setActiveSession(parentId)
    const anchor = session.branchedFromMessageId
    if (!anchor) return
    // The parent pane mounts its own message list, which is what registers
    // `jumpToMessage`. Defer so the jump runs against the parent's list rather
    // than the one being torn down.
    requestAnimationFrame(() => {
      const jump = useChatViewportStore.getState().jumpToMessage ?? jumpToMessage
      // A branch point that was compacted away or truncated by an edit simply
      // doesn't move the viewport; the jump API reports no outcome to surface.
      jump?.(anchor)
    })
  }

  return (
    <button
      type="button"
      onClick={onJump}
      title={label}
      aria-label={t("ariaLineage", { title: parent?.title ?? "" })}
      data-testid="branch-lineage-chip"
      className={cn(
        "flex min-w-0 shrink items-center gap-1 rounded px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
        className
      )}
    >
      <GitBranchIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  )
}
