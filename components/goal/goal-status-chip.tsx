"use client"

/**
 * A goal's status as a tinted chip with a dot that pulses while the goal runs
 * (ADR-0019). One drawing for every surface — the console list and grid, the
 * history table, the inspector and the phone rows — where the card, the
 * mobile row and the history table each used to draw (or not draw) their own.
 *
 * A goal parked by the acceptance gate is `paused` to the runtime but waiting
 * on the user, not on a resume; the chip says "awaiting acceptance" in the
 * paused tone so the two never read as the same thing.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { isAwaitingAcceptance } from "@/lib/goal/overview-filter"
import type { Goal } from "@/types/goal"

import { goalStatusStyle } from "./goal-status-style"

export interface GoalStatusChipProps {
  goal: Pick<Goal, "status" | "awaitingAcceptance">
  size?: "sm" | "md"
  className?: string
}

export function GoalStatusChip({ goal, size = "md", className }: GoalStatusChipProps) {
  const t = useTranslations("goal")
  const style = goalStatusStyle(goal.status)
  const awaiting = isAwaitingAcceptance(goal)
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill font-medium",
        size === "sm" ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-[11px]",
        style.chip,
        className
      )}
      data-testid="goal-status-chip"
      data-status={goal.status}
      data-awaiting={awaiting || undefined}
    >
      <span className="relative flex size-1.5" aria-hidden>
        {style.pulse ? (
          <span
            className={cn(
              "absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping",
              style.dot
            )}
          />
        ) : null}
        <span className={cn("relative inline-flex size-1.5 rounded-full", style.dot)} />
      </span>
      {/* The status labels are lower-case so they read inside sentences
          ("Goal · paused"); a chip starts one, so its first letter is raised. */}
      <span className="inline-block first-letter:uppercase">
        {awaiting ? t("status.awaitingAcceptance") : t(`status.${goal.status}`)}
      </span>
    </span>
  )
}

GoalStatusChip.displayName = "GoalStatusChip"
