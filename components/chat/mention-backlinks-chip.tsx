"use client"

/**
 * "Referenced by N conversations" — the reverse of an `@` mention.
 *
 * Shaped after the provenance chip family already in the chat header
 * (`branch-lineage-chip`, `branch-children-chip`, `imported-origin-chip`): a
 * small self-hiding chip that costs nothing when there is nothing to say, and
 * opens a list that navigates. This is the fourth question of the same kind —
 * where did this come from, what came out of it, and now, who else reached for
 * it.
 *
 * The data has been on disk the whole time. `metadata.mentions` is written on
 * every user message that cites something, and until the backlink index
 * (`lib/db/mention-links.ts`) it was only ever read in the forward direction.
 *
 * Renders nothing for a record nothing has referenced.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CornerUpLeftIcon } from "lucide-react"

import {
  EMPTY_BACKLINKS,
  loadBacklinks,
  type BacklinkSummary,
  type BacklinkTarget,
} from "@/lib/chat/mentions/backlinks"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export interface MentionBacklinksChipProps {
  target: BacklinkTarget
  /**
   * Conversation to leave out — the one being displayed. A turn citing an
   * earlier turn of its own chat is a real citation but not a backlink in the
   * sense the badge means, which is "who ELSE reached for this".
   */
  excludeSessionId?: string
  className?: string
}

/**
 * Load a record's backlinks.
 *
 * Not a `useLiveQuery`: the index is written by an idle indexer that runs after
 * every turn, so a live subscription would re-render this chip on unrelated
 * conversations' writes. A read on mount and on the target changing is what the
 * answer actually depends on.
 */
export function useBacklinks(target: BacklinkTarget, excludeSessionId?: string): BacklinkSummary {
  const [summary, setSummary] = useState<BacklinkSummary>(EMPTY_BACKLINKS)
  const { refKind, refId } = target

  useEffect(() => {
    let cancelled = false
    loadBacklinks({ refKind, refId }, excludeSessionId ? { excludeSessionId } : {})
      .then((next) => {
        if (!cancelled) setSummary(next)
      })
      // A backlink panel that cannot read stays empty and silent. It is an
      // extra, and failing loudly would be worse than not showing it.
      .catch(() => {
        if (!cancelled) setSummary(EMPTY_BACKLINKS)
      })
    return () => {
      cancelled = true
    }
  }, [refKind, refId, excludeSessionId])

  return summary
}

/**
 * The list body, reusable outside the chat header.
 *
 * Same component behind the chip's dropdown and the record detail panels
 * (`/memory`, `/issues`, a plan), because "which conversations used this" is
 * one question with one answer wherever it is asked.
 */
export function MentionBacklinksList({ summary }: { summary: BacklinkSummary }) {
  const t = useTranslations("chat.backlinks")

  const open = useCallback((sessionId: string, messageId: string) => {
    // Lands on the exact citing turn, not on the conversation's tail — the
    // point of the list is to show you what someone said about it.
    void jumpToSessionMessage(sessionId, messageId)
  }, [])

  return (
    <>
      {summary.groups.map((group) => (
        <DropdownMenuItem
          key={group.sessionId}
          className="text-xs"
          data-testid="mention-backlink-row"
          onSelect={() => open(group.sessionId, group.messageId)}
        >
          <span className="truncate">{group.sessionTitle}</span>
          {group.count > 1 ? (
            <span className="ml-auto shrink-0 pl-2 text-muted-foreground">
              {t("timesInConversation", { count: group.count })}
            </span>
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  )
}

export function MentionBacklinksChip({
  target,
  excludeSessionId,
  className,
}: MentionBacklinksChipProps) {
  const t = useTranslations("chat.backlinks")
  const summary = useBacklinks(target, excludeSessionId)

  if (summary.groups.length === 0) return null

  const label = t("chipLabel", { count: summary.groups.length })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          data-testid="mention-backlinks-chip"
          className={cn(
            "flex min-w-0 shrink items-center gap-1 rounded px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
            className
          )}
        >
          <CornerUpLeftIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[20rem]">
        <DropdownMenuLabel className="text-xs">{t("listLabel")}</DropdownMenuLabel>
        <MentionBacklinksList summary={summary} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The record-side panel: the same answer, rendered inline instead of behind a
 * chip.
 *
 * A memory's or an issue's detail view has room to say it outright, and the
 * question is more load-bearing there — "is anything actually using this" is
 * how you decide whether a record still earns its place.
 */
export function MentionBacklinksPanel({
  target,
  className,
}: {
  target: BacklinkTarget
  className?: string
}) {
  const t = useTranslations("chat.backlinks")
  const summary = useBacklinks(target)

  if (summary.groups.length === 0) return null

  return (
    <div className={cn("mt-2 text-xs", className)} data-testid="mention-backlinks-panel">
      <p className="mb-1 text-muted-foreground">
        {t("panelTitle")} · {t("chipLabel", { count: summary.groups.length })}
      </p>
      <ul className="space-y-0.5">
        {summary.groups.map((group) => (
          <li key={group.sessionId}>
            <button
              type="button"
              data-testid="mention-backlink-row"
              onClick={() => void jumpToSessionMessage(group.sessionId, group.messageId)}
              className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left underline-offset-2 hover:bg-muted/50 hover:underline"
            >
              <span className="truncate">{group.sessionTitle}</span>
              {group.count > 1 ? (
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {t("timesInConversation", { count: group.count })}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
