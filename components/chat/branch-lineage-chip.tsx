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
import { toast } from "sonner"

import type { ChatSession } from "@cognia/agent-config-types"
import { getSession } from "@/lib/db/sessions"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"
import { useChatStore } from "@/stores/chat"
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
  const parent = useLiveQuery(
    async () => (parentId ? ((await getSession(parentId)) ?? null) : null),
    [parentId]
  )

  if (!parentId) return null

  // One resolved title for both the visible label and the accessible name —
  // reading `parent?.title ?? ""` separately let the aria-label degrade to
  // "…created from, in " for a deleted parent while the label read correctly.
  const parentTitle = parent?.title || t("lineageUnknownParent")
  const label = t("lineage", { title: parentTitle })

  const onJump = () => {
    const anchor = session.branchedFromMessageId
    if (!anchor) {
      useChatStore.getState().setActiveSession(parentId)
      return
    }
    // Crossing into the parent means waiting for ITS history, not for one
    // animation frame: unless that pane was already open and hydrated, a single
    // `requestAnimationFrame` reported "branch point missing" for a message
    // that exists and is about to render. ADR-0094 requires the wait, and
    // `jumpToSessionMessage` owns it.
    void jumpToSessionMessage(parentId, anchor, { align: "center" }).then((landed) => {
      // A branch point compacted away or truncated by an edit genuinely is not
      // there any more — say so rather than leaving the click looking ignored.
      if (!landed) toast.error(t("lineageAnchorMissing"))
    })
  }

  return (
    <button
      type="button"
      onClick={onJump}
      title={label}
      aria-label={t("ariaLineage", { title: parentTitle })}
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
