"use client"

/**
 * The board cue for an issue's wakeups: how many rules are waiting on it, and
 * whether one stopped itself (loop, rate, the issue finished).
 *
 * A paused rule wins the cue. A stopped rule is the one state a person has to
 * act on, and "3 waiting" next to it would read as healthy. Held inputs are
 * named in the tooltip: something happened that no agent has seen yet.
 * Purely informational; the detail panel is where rules are managed.
 */

import { useTranslations } from "next-intl"
import { AlarmClockIcon, AlarmClockOffIcon } from "lucide-react"

import type { IssueWakeupCue } from "@/lib/issues/wakeups/model"
import { cn } from "@/lib/utils"

export interface WakeupCueChipProps {
  cue: IssueWakeupCue
  className?: string
}

export function WakeupCueChip({ cue, className }: WakeupCueChipProps) {
  const t = useTranslations("issues.wakeups.cue")
  if (cue.active === 0 && cue.paused === 0) return null

  const stopped = cue.paused > 0
  const parts = [
    stopped
      ? cue.pauseReason
        ? t("pausedWith", { count: cue.paused, reason: t(`reason.${cue.pauseReason}`) })
        : t("paused", { count: cue.paused })
      : t("active", { count: cue.active }),
  ]
  if (stopped && cue.active > 0) parts.push(t("active", { count: cue.active }))
  if (cue.held > 0) parts.push(t("held", { count: cue.held }))
  const label = parts.join(" · ")
  const Icon = stopped ? AlarmClockOffIcon : AlarmClockIcon

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="issue-card-wakeup-cue"
      data-state={stopped ? "paused" : "active"}
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-0.5 text-[10px] tabular-nums",
        stopped ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        className
      )}
    >
      <Icon aria-hidden className="size-3" />
      {stopped ? cue.paused : cue.active}
    </span>
  )
}
