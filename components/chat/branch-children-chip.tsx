"use client"

/**
 * "N branches" chip for a conversation that has been branched FROM.
 *
 * The reverse of {@link BranchLineageChip}. Lineage was one-directional and
 * one-level: a child could point back at its parent, but a parent had no idea it
 * had been branched at all — so a conversation you had explored three ways
 * looked exactly like one you had never touched, and the only way to find those
 * branches was to recognise their titles in the sidebar.
 *
 * Reads through the `parentSessionId` index (Dexie v81), which existed for this
 * and had no query behind it until now. Deliberately a flat list rather than a
 * recursive tree: depth beyond one level is rare, a tree is a whole new heavy
 * surface, and each branch shows its own chip once opened — so the tree is
 * walkable one hop at a time.
 *
 * Renders nothing for a conversation with no branches.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { GitBranchIcon } from "lucide-react"

import { listSessionBranches } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export function BranchChildrenChip({
  sessionId,
  className,
}: {
  sessionId: string
  className?: string
}) {
  const t = useTranslations("chat.branch")
  const branches = useLiveQuery(() => listSessionBranches(sessionId), [sessionId]) ?? []

  if (branches.length === 0) return null

  const label = t("childCount", { count: branches.length })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          data-testid="branch-children-chip"
          className={cn(
            "flex min-w-0 shrink items-center gap-1 rounded px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
            className
          )}
        >
          <GitBranchIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[18rem]">
        <DropdownMenuLabel className="text-xs">{t("childListLabel")}</DropdownMenuLabel>
        {branches.map((branch) => (
          <DropdownMenuItem
            key={branch.id}
            className="text-xs"
            onSelect={() => {
              // Land on the branch's own thread. Unlike the lineage chip there
              // is no anchor to seek — the branch point is where the child
              // *starts*, so opening it is the whole navigation.
              const store = useChatStore.getState()
              store.openSession(branch.id)
              store.setActiveSession(branch.id)
            }}
          >
            <span className="truncate">{branch.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * "N branches taken here" marker for the message a branch was cut at.
 *
 * Sits with the message rather than the header so the branch point is visible
 * where the decision was made — scrolling a long thread shows exactly where it
 * forked. Clicking jumps into the (most recent) branch.
 */
export function BranchPointMarker({
  sessionId,
  messageId,
  className,
}: {
  sessionId: string
  messageId: string
  className?: string
}) {
  const t = useTranslations("chat.branch")
  // Deliberately the SAME query as the header chip, filtered during render
  // rather than inside the live query: one subscription per session serves
  // every message row, instead of one per row keyed by its own message id.
  const all = useLiveQuery(() => listSessionBranches(sessionId), [sessionId]) ?? []
  const branches = all.filter((s) => s.branchedFromMessageId === messageId)

  if (branches.length === 0) return null

  const label = t("pointCount", { count: branches.length })

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid="branch-point-marker"
      onClick={() => {
        const store = useChatStore.getState()
        // Newest first (see `listSessionBranches`) — the most recent attempt is
        // the one being compared against.
        store.openSession(branches[0].id)
        store.setActiveSession(branches[0].id)
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
        className
      )}
    >
      <GitBranchIcon className="size-3 shrink-0" aria-hidden />
      <span>{label}</span>
    </button>
  )
}
