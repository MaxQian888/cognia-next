"use client"

/**
 * One open goal as a tile, for the Goals console's optional grid view
 * (ADR-0019). The list is the default; the grid is for someone running a
 * handful of goals who wants their objectives side by side.
 *
 * One frame, nothing nested in it: the old card drew a coloured rail inside a
 * bordered, shadowed box and lifted on hover, and the shadow made a page of
 * them read as a stack of cards. The tile is a plain bordered surface; status
 * is the chip, budgets are two meters, and a selected tile carries a ring
 * instead of a heavier box. Like the list row, the whole tile selects the goal
 * into the inspector through a stretched button, and the link, controls and
 * menu above it act on their own.
 */

import { useLocale, useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"

import {
  formatGoalDuration,
  formatGoalTokens,
  goalBudgetPercent,
  goalRunDurationMs,
} from "@/lib/goal/format"
import { isAwaitingAcceptance } from "@/lib/goal/overview-filter"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

import { GoalAcceptanceActions } from "../goal-acceptance-actions"
import { GoalActionsMenu } from "../goal-actions-menu"
import { GoalControlBar } from "../goal-control-bar"
import { GoalConversationLink } from "../goal-conversation-link"
import { GoalStatusChip } from "../goal-status-chip"
import { goalStatusStyle } from "../goal-status-style"

export interface GoalGridTileProps {
  goal: Goal
  session: ChatSession | null | undefined
  agentName: string | undefined
  judgeNote?: string | null
  selected: boolean
  onSelect: (goalId: string) => void
  onDeleted: (goalId: string) => void
  now: number
}

export function GoalGridTile({
  goal,
  session,
  agentName,
  judgeNote,
  selected,
  onSelect,
  onDeleted,
  now,
}: GoalGridTileProps) {
  const t = useTranslations("goal")
  const locale = useLocale()
  const style = goalStatusStyle(goal.status)
  const awaiting = isAwaitingAcceptance(goal)
  const subgoals = goal.subgoals ?? []
  const subgoalsDone = subgoals.filter((step) => step.done).length

  return (
    <Surface asChild layer="raised" radius="panel">
      <li
        className={cn(
          "relative flex min-w-0 flex-col gap-3 border p-4 transition-colors",
          "hover:border-foreground/20 has-[[data-goal-select]:focus-visible]:ring-2 has-[[data-goal-select]:focus-visible]:ring-ring/60",
          selected && "border-primary/40 ring-2 ring-primary/25"
        )}
        data-testid="goal-grid-tile"
        data-goal-id={goal.id}
        data-selected={selected || undefined}
      >
        <div className="flex items-center justify-between gap-2">
          <GoalStatusChip goal={goal} size="sm" />
          <span
            className="text-[11px] tabular-nums text-muted-foreground"
            title={t("card.runningFor")}
          >
            {formatGoalDuration(goalRunDurationMs(goal, now), locale)}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onSelect(goal.id)}
          aria-current={selected ? "true" : undefined}
          title={goal.safeObjective}
          className="line-clamp-2 min-h-10 text-left text-sm font-medium leading-snug outline-none after:absolute after:inset-0 after:rounded-panel after:content-['']"
          data-goal-select={goal.id}
          data-testid="goal-grid-tile-select"
        >
          {goal.safeObjective}
        </button>

        <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground [&_a]:pointer-events-auto">
          <GoalConversationLink sessionId={goal.sessionId} session={session} className="shrink" />
          {agentName ? (
            <>
              <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="truncate">{agentName}</span>
            </>
          ) : null}
        </div>

        <div className="space-y-2">
          <TileMeter
            label={t("card.turns")}
            value={`${goal.turnsUsed}/${goal.config.maxTurns}`}
            percent={goalBudgetPercent(goal.turnsUsed, goal.config.maxTurns)}
            barClass={style.bar}
          />
          <TileMeter
            label={t("card.tokens")}
            value={`${formatGoalTokens(goal.tokensUsed, locale)}/${formatGoalTokens(
              goal.config.maxTokens,
              locale
            )}`}
            percent={goalBudgetPercent(goal.tokensUsed, goal.config.maxTokens)}
            barClass={style.bar}
          />
        </div>

        {judgeNote ? (
          <p className="line-clamp-1 text-xs italic text-muted-foreground">
            {t("overview.reasonQuoted", { reason: judgeNote })}
          </p>
        ) : null}

        <div className="relative z-10 mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {subgoals.length > 0
              ? t("subgoals.inline", { done: subgoalsDone, total: subgoals.length })
              : null}
          </span>
          <div className="flex items-center gap-1">
            {awaiting ? (
              <GoalAcceptanceActions goal={goal} size="compact" />
            ) : (
              <GoalControlBar goal={goal} />
            )}
            <GoalActionsMenu
              goal={goal}
              conversationMissing={session === null}
              onOpenDetails={() => onSelect(goal.id)}
              onDeleted={() => onDeleted(goal.id)}
            />
          </div>
        </div>
      </li>
    </Surface>
  )
}

function TileMeter({
  label,
  value,
  percent,
  barClass,
}: {
  label: string
  value: string
  percent: number
  barClass: string
}) {
  return (
    <div role="group" aria-label={`${label} ${value}`}>
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", barClass)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
