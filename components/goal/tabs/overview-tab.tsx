"use client"

/**
 * Overview tab of the goal inspector (ADR-0019): where the goal stands against
 * its limits, and what the loop last decided.
 *
 *   Budget   turns, tokens and (for an open goal) wall-clock time left, each a
 *            meter in the goal's status tone, plus the per-turn cost ceiling
 *   Loop     the next scheduled continuation, a pending completion promise
 *   Judge    the latest verdict and, for a finished goal, why it stopped
 *
 * The objective, status and dates are the inspector header's, so they are not
 * repeated here.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl"

import { listGoalEvents } from "@/lib/db/goals"
import { formatGoalDuration, formatGoalTokens, goalBudgetPercent } from "@/lib/goal/format"
import { cn } from "@/lib/utils"
import { isTerminalGoalStatus, type Goal } from "@/types/goal"

import { goalStatusStyle } from "../goal-status-style"

interface Props {
  goal: Goal
}

export function GoalOverviewTab({ goal }: Props) {
  const t = useTranslations("goal")
  const format = useFormatter()
  const locale = useLocale()
  const now = useNow({ updateInterval: 60_000 })
  const style = goalStatusStyle(goal.status)
  const terminal = isTerminalGoalStatus(goal.status)

  const events = useLiveQuery(() => listGoalEvents(goal.id, 50), [goal.id])
  const lastJudge = events?.find((e) => e.kind === "judge_evaluated")
  const lastReason = lastJudge?.payload.kind === "judge_evaluated" ? lastJudge.payload.reason : null
  const exit = events?.find((e) => e.kind === "exit_triggered")
  const exitReason = exit?.payload.kind === "exit_triggered" ? exit.payload.reason : null

  const deadline = goal.createdAt + goal.config.timeoutMs
  const timeLeftMs = Math.max(0, deadline - now.getTime())

  return (
    <div className="space-y-6 text-sm" data-testid="goal-overview-tab">
      <section className="space-y-3">
        <SectionLabel>{t("overview.budgetHeading")}</SectionLabel>
        <Meter
          label={t("overview.turns")}
          value={`${goal.turnsUsed} / ${goal.config.maxTurns}`}
          percent={goalBudgetPercent(goal.turnsUsed, goal.config.maxTurns)}
          barClass={style.bar}
          ariaLabel={t("overview.turnBudgetAria")}
        />
        <Meter
          label={t("overview.tokens")}
          value={`${formatGoalTokens(goal.tokensUsed, locale)} / ${formatGoalTokens(
            goal.config.maxTokens,
            locale
          )}`}
          title={`${format.number(goal.tokensUsed)} / ${format.number(goal.config.maxTokens)}`}
          percent={goalBudgetPercent(goal.tokensUsed, goal.config.maxTokens)}
          barClass={style.bar}
          ariaLabel={t("overview.tokenBudgetAria")}
        />
        {!terminal ? (
          <Meter
            label={t("overview.timeLeft")}
            // Past the wall-clock cap but not yet timed out by the runtime
            // (it checks on the next turn): say so instead of "0 sec".
            value={timeLeftMs > 0 ? formatGoalDuration(timeLeftMs, locale) : t("overview.timeUp")}
            percent={goalBudgetPercent(goal.config.timeoutMs - timeLeftMs, goal.config.timeoutMs)}
            barClass={style.bar}
            ariaLabel={t("overview.timeBudgetAria")}
            testId="goal-overview-time-left"
          />
        ) : null}
        {goal.config.maxBudgetUsd ? (
          <p className="text-xs text-muted-foreground" data-testid="goal-overview-cost-ceiling">
            {t("overview.costCeiling", {
              amount: format.number(goal.config.maxBudgetUsd, {
                style: "currency",
                currency: "USD",
              }),
            })}
          </p>
        ) : null}
      </section>

      {goal.status === "active" && (goal.nextContinuationAt || goal.awaitingPromise) ? (
        <section className="space-y-1.5">
          <SectionLabel>{t("overview.loopHeading")}</SectionLabel>
          {goal.nextContinuationAt ? (
            <p data-testid="goal-overview-next-continuation">
              {t("pill.nextContinuation", {
                time: format.dateTime(new Date(goal.nextContinuationAt), { timeStyle: "short" }),
                reason: t(`pill.pacingReason.${goal.nextContinuationSource ?? "interval"}`),
              })}
            </p>
          ) : null}
          {goal.awaitingPromise ? (
            <p className="text-warning">{t("overview.awaitingPromise")}</p>
          ) : null}
        </section>
      ) : null}

      {lastReason || exitReason ? (
        <section className="space-y-3">
          <SectionLabel>{t("overview.judgeHeading")}</SectionLabel>
          {lastReason ? (
            <div>
              <p className="text-xs text-muted-foreground">{t("overview.lastJudgeReason")}</p>
              <p className="mt-1 italic">{t("overview.reasonQuoted", { reason: lastReason })}</p>
            </div>
          ) : null}
          {exitReason ? (
            <div>
              <p className="text-xs text-muted-foreground">{t("overview.exitReason")}</p>
              <p className="mt-1">{exitReason}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      {goal.status === "active" ? (
        <p
          className="border-t pt-3 text-xs text-muted-foreground"
          data-testid="goal-foreground-dormancy-note"
        >
          {t("overview.foregroundDormancy")}
        </p>
      ) : null}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>
}

function Meter({
  label,
  value,
  title,
  percent,
  barClass,
  ariaLabel,
  testId,
}: {
  label: string
  value: string
  title?: string
  percent: number
  barClass: string
  ariaLabel: string
  testId?: string
}) {
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground" title={title}>
          {value}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", barClass)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
