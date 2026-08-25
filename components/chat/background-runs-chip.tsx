"use client"

/**
 * "N running" — the only thing in a single-conversation shell that admits
 * other conversations are working.
 *
 * The mobile shell shows exactly one conversation and derived every status
 * from the focused slice, so a phone that had kicked off three turns and
 * navigated away looked completely idle. Concurrency was not hidden behind a
 * menu there; it had no representation at all.
 *
 * Deliberately counts only work happening ELSEWHERE. A chip that also counted
 * the conversation already on screen would light up during ordinary use and
 * stop meaning anything — the signal is "there is something you are not
 * looking at", and it disappears the moment that stops being true.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { LoaderCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { backgroundActiveSessionIds } from "@/lib/chat/aggregate-run-state"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"

export interface BackgroundRunsChipProps {
  /**
   * Jump to a conversation running in the background. The shell owns this —
   * on mobile it also has to close the sheet and switch the visible pane.
   */
  onSelect?: (sessionId: string) => void
  className?: string
}

export function BackgroundRunsChip({ onSelect, className }: BackgroundRunsChipProps) {
  const t = useTranslations("chat.backgroundRuns")
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  // One scan, not two: `aggregateRunState().activeElsewhere` is by construction
  // `backgroundIds.length > 0` — same predicate, same input — and this
  // component re-renders once per animation frame for the whole of any stream.
  const backgroundIds = useMemo(
    () => backgroundActiveSessionIds({ sessions, activeSessionId }),
    [sessions, activeSessionId]
  )

  if (backgroundIds.length === 0) return null

  const first = backgroundIds[0]!
  const label = t("count", { count: backgroundIds.length })
  const interactive = Boolean(onSelect)

  return (
    <Badge
      variant="secondary"
      // Not a button when there is nowhere to go: a chip that looks pressable
      // and does nothing is worse than a plain readout.
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            onClick: () => onSelect?.(first),
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onSelect?.(first)
              }
            },
          }
        : {})}
      aria-label={label}
      title={label}
      data-testid="background-runs-chip"
      data-count={backgroundIds.length}
      className={cn("shrink-0 gap-1 font-normal", interactive && "cursor-pointer", className)}
    >
      <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
      <span className="tabular-nums">{backgroundIds.length}</span>
    </Badge>
  )
}
