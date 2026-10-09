"use client"

/**
 * One open goal in the Goals console list (ADR-0019) — the default view.
 *
 *   ● Active  Get the checkout e2e suite green on CI…     Turns ▂▂ 4/20  Tokens ▂ 42K  3 hr  ⏸ ⏹ ⋯
 *             💬 Fix flaky checkout e2e test · Coding Assistant · Subgoals 2/3 · “needs a retry”
 *
 * Two lines: what the goal is for, then where it runs and how far along it
 * is. The whole row selects the goal into the inspector (a stretched button
 * under the objective); the conversation link, the controls and the ⋯ menu sit
 * above that button and act on their own. Below the container's `@2xl` the
 * budget meters fold into the second line as text, so the objective keeps its
 * room on a narrow window.
 *
 * A goal waiting on the acceptance gate carries Accept / Request changes
 * instead of the run controls — the verdict is what moves it.
 */

import { forwardRef } from "react"
import { useLocale, useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"

import {
  formatGoalDuration,
  formatGoalTokens,
  goalBudgetPercent,
  goalRunDurationMs,
} from "@/lib/goal/format"
import { isAwaitingAcceptance } from "@/lib/goal/overview-filter"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

import { GoalAcceptanceActions } from "../goal-acceptance-actions"
import { GoalActionsMenu } from "../goal-actions-menu"
import { GoalControlBar } from "../goal-control-bar"
import { GoalConversationLink } from "../goal-conversation-link"
import { GoalStatusChip } from "../goal-status-chip"
import { goalStatusStyle } from "../goal-status-style"

export interface GoalListRowProps {
  goal: Goal
  /** The goal's conversation: `undefined` while loading, `null` once known gone. */
  session: ChatSession | null | undefined
  agentName: string | undefined
  /** Latest judge note, when the caller has one to show. */
  judgeNote?: string | null
  selected: boolean
  onSelect: (goalId: string) => void
  onDeleted: (goalId: string) => void
  /** The list's clock (ms), so every row ticks together. */
  now: number
}

export const GoalListRow = forwardRef<HTMLButtonElement, GoalListRowProps>(function GoalListRow(
  { goal, session, agentName, judgeNote, selected, onSelect, onDeleted, now },
  ref
) {
  const t = useTranslations("goal")
  const locale = useLocale()
  const style = goalStatusStyle(goal.status)
  const awaiting = isAwaitingAcceptance(goal)
  const subgoals = goal.subgoals ?? []
  const subgoalsDone = subgoals.filter((step) => step.done).length
  const turnsText = `${goal.turnsUsed}/${goal.config.maxTurns}`
  const tokensText = `${formatGoalTokens(goal.tokensUsed, locale)}/${formatGoalTokens(
    goal.config.maxTokens,
    locale
  )}`

  return (
    <li
      className={cn(
        "group/goal-row relative border-b border-border/60 transition-colors last:border-b-0",
        "hover:bg-muted/40 has-[[data-goal-select]:focus-visible]:bg-muted/40",
        selected && "bg-accent/50 hover:bg-accent/60"
      )}
      data-testid="goal-list-row"
      data-goal-id={goal.id}
      data-selected={selected || undefined}
    >
      {/* Selected rows carry a status-toned edge so the eye can find the row
          the inspector is showing without reading every title. */}
      {selected ? (
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", style.rail)} />
      ) : null}
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5 @md/goal-list:px-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <GoalStatusChip goal={goal} size="sm" />
            <button
              ref={ref}
              type="button"
              onClick={() => onSelect(goal.id)}
              aria-current={selected ? "true" : undefined}
              title={goal.safeObjective}
              className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium outline-none after:absolute after:inset-0 after:content-['']"
              data-goal-select={goal.id}
              data-testid="goal-list-row-select"
            >
              {goal.safeObjective}
            </button>
          </div>
          {/* Above the stretched select button so the link takes its own
              clicks, and click-through everywhere else so the rest of the
              line still selects the row. */}
          <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-1.5 pl-0.5 text-[11px] text-muted-foreground [&_a]:pointer-events-auto">
            <GoalConversationLink
              sessionId={goal.sessionId}
              session={session}
              className="max-w-[45%] shrink"
            />
            {agentName ? (
              <>
                <Dot />
                <span className="truncate">{agentName}</span>
              </>
            ) : null}
            {subgoals.length > 0 ? (
              <>
                <Dot />
                <span className="shrink-0 tabular-nums">
                  {t("subgoals.inline", { done: subgoalsDone, total: subgoals.length })}
                </span>
              </>
            ) : null}
            {/* Budgets fold into text here when the meters have no room. */}
            <span className="flex shrink-0 items-center gap-1.5 @2xl/goal-list:hidden">
              <Dot />
              <span className="tabular-nums">
                {t("card.inlineBudget", { turns: turnsText, tokens: tokensText })}
              </span>
            </span>
            {judgeNote ? (
              <>
                <Dot />
                <span className="hidden min-w-0 truncate italic @3xl/goal-list:inline">
                  {t("overview.reasonQuoted", { reason: judgeNote })}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className="hidden shrink-0 items-center gap-4 @2xl/goal-list:flex">
          <MiniMeter
            label={t("card.turns")}
            value={turnsText}
            percent={goalBudgetPercent(goal.turnsUsed, goal.config.maxTurns)}
            barClass={style.bar}
          />
          <MiniMeter
            label={t("card.tokens")}
            value={tokensText}
            percent={goalBudgetPercent(goal.tokensUsed, goal.config.maxTokens)}
            barClass={style.bar}
          />
        </div>

        <span
          className="hidden w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground @lg/goal-list:inline"
          title={t("card.runningFor")}
        >
          {formatGoalDuration(goalRunDurationMs(goal, now), locale)}
        </span>

        <div className="relative z-10 flex shrink-0 items-center gap-1">
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
  )
})

function Dot() {
  return <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/60" />
}

function MiniMeter({
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
    <div className="w-24 space-y-1" aria-label={`${label} ${value}`} role="group">
      <div className="flex items-baseline justify-between gap-1 text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn("h-full rounded-full", barClass)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
