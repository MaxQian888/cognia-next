"use client"

/**
 * A conversation's goal, as a small chip on its row in the conversation
 * manager (ADR-0019 × ADR-0213).
 *
 * Open goals show in their status tone with the turn count ("◎ Active 4/20");
 * a finished goal shows muted, so a conversation that once ran a goal says so
 * without competing with the ones still running. The chip opens that goal in
 * the Goals console's inspector (`/goals?goal=…`), the way back the console's
 * conversation links already offer in the other direction.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { TargetIcon } from "lucide-react"

import { goalStatusStyle } from "@/components/goal/goal-status-style"
import { goalConsoleHref } from "@/lib/goal/console-prefs"
import { isAwaitingAcceptance, isOpenGoal } from "@/lib/goal/overview-filter"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

export interface ConversationGoalChipProps {
  goal: Pick<
    Goal,
    "id" | "status" | "awaitingAcceptance" | "turnsUsed" | "config" | "safeObjective"
  >
  className?: string
}

export function ConversationGoalChip({ goal, className }: ConversationGoalChipProps) {
  const t = useTranslations("conversations.manager.goal")
  const tGoal = useTranslations("goal")
  const open = isOpenGoal(goal)
  const style = goalStatusStyle(goal.status)
  const status = isAwaitingAcceptance(goal)
    ? tGoal("status.awaitingAcceptance")
    : tGoal(`status.${goal.status}`)

  return (
    <Link
      href={goalConsoleHref({ goalId: goal.id })}
      onClick={(event) => event.stopPropagation()}
      title={goal.safeObjective}
      aria-label={t("open", { status, objective: goal.safeObjective })}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-pill px-1.5 text-[10px] font-medium leading-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        open ? style.chip : "bg-muted text-muted-foreground",
        className
      )}
      data-testid={`conversation-goal-chip-${goal.id}`}
      data-open={open || undefined}
    >
      <TargetIcon className="size-3" aria-hidden />
      <span className="first-letter:uppercase">{status}</span>
      {open ? (
        <span className="tabular-nums opacity-80">
          {goal.turnsUsed}/{goal.config.maxTurns}
        </span>
      ) : null}
    </Link>
  )
}

ConversationGoalChip.displayName = "ConversationGoalChip"
