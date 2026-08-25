"use client"

/**
 * Rich open-goal card for the Mission Control console (ADR-0019 Phase 3).
 * A status-color rail, prominent objective, twin progress meters, the latest
 * judge verdict, and inline controls. Opens the shared `GoalDetailSheet`.
 * Reuses the runtime + status visual language so it stays in lockstep with
 * the composer pill.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Maximize2Icon, PauseIcon, PlayIcon, SquareIcon, StepForwardIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { listGoalEvents } from "@/lib/db/goals"
import { getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"
import { goalStatusStyle } from "../goal-status-style"
import { GoalDetailSheet } from "../goal-detail-sheet"

interface Props {
  goal: Goal
  /**
   * `"card"` (default) is the full grid card with progress meters + judge
   * reason. `"compact"` is a tighter single-row layout for the console's list
   * view — meters collapse to inline text and the judge reason is dropped.
   */
  variant?: "card" | "compact"
}

export function ActiveGoalCard({ goal, variant = "card" }: Props) {
  const t = useTranslations("goal")
  const [open, setOpen] = useState(false)
  const style = goalStatusStyle(goal.status)
  const isActive = goal.status === "active"
  const isPaused = goal.status === "paused"

  const events = useLiveQuery(() => listGoalEvents(goal.id, 20), [goal.id])
  const lastJudge = events?.find((e) => e.kind === "judge_evaluated")
  const lastReason = lastJudge?.payload.kind === "judge_evaluated" ? lastJudge.payload.reason : null

  // Lazy init keeps Date.now() out of the render body; the interval re-ticks
  // the elapsed counter so it stays live while the goal runs.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const minutes = Math.max(0, Math.round((now - goal.createdAt) / 60_000))

  const controls = (
    <div className="flex items-center justify-end gap-1">
      {isActive && goal.config.manualContinue && (
        <Control
          label={t("pill.continue")}
          testId="active-card-continue"
          onClick={() => getGoalRuntime().requestManualContinue(goal.id)}
        >
          <StepForwardIcon className="size-4" aria-hidden />
        </Control>
      )}
      {isActive && (
        <Control
          label={t("pill.pause")}
          testId="active-card-pause"
          onClick={() => void getGoalRuntime().pauseGoal(goal.id)}
        >
          <PauseIcon className="size-4" aria-hidden />
        </Control>
      )}
      {isPaused && (
        <Control
          label={t("pill.resume")}
          testId="active-card-resume"
          onClick={() => void getGoalRuntime().resumeGoal(goal.id)}
        >
          <PlayIcon className="size-4" aria-hidden />
        </Control>
      )}
      <Control
        label={t("pill.stop")}
        testId="active-card-stop"
        onClick={() => void getGoalRuntime().stopGoal(goal.id)}
      >
        <SquareIcon className="size-4" aria-hidden />
      </Control>
      <Control label={t("pill.details")} testId="active-card-details" onClick={() => setOpen(true)}>
        <Maximize2Icon className="size-4" aria-hidden />
      </Control>
    </div>
  )

  const statusChip = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        style.chip
      )}
    >
      <span className="relative flex size-1.5">
        {style.pulse && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60",
              style.dot
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", style.dot)} />
      </span>
      {t(`status.${goal.status}`)}
    </span>
  )

  if (variant === "compact") {
    return (
      <article
        data-testid="active-goal-card"
        data-variant="compact"
        className="group relative flex items-center gap-3 overflow-hidden rounded-xl border bg-card px-4 py-3 pl-5 shadow-sm transition-shadow hover:shadow-md"
      >
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", style.rail)} />
        {statusChip}
        <p className="min-w-0 flex-1 truncate text-sm font-medium" title={goal.safeObjective}>
          {goal.safeObjective}
        </p>
        <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:inline">
          {goal.turnsUsed}/{goal.config.maxTurns} · {kfmt(goal.tokensUsed)}/
          {kfmt(goal.config.maxTokens)}
        </span>
        {controls}
        <GoalDetailSheet goal={goal} open={open} onOpenChange={setOpen} />
      </article>
    )
  }

  return (
    <article
      data-testid="active-goal-card"
      className="group relative overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md"
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", style.rail)} />
      <div className="space-y-3 p-4 pl-5">
        <div className="flex items-center justify-between gap-2">
          {statusChip}
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t("card.elapsed", { minutes })}
          </span>
        </div>

        <p className="line-clamp-2 text-sm font-medium leading-snug" title={goal.safeObjective}>
          {goal.safeObjective}
        </p>

        <div className="space-y-2">
          <Meter
            label={t("card.turns")}
            valueText={`${goal.turnsUsed}/${goal.config.maxTurns}`}
            pct={pct(goal.turnsUsed, goal.config.maxTurns)}
            barClass={style.bar}
          />
          <Meter
            label={t("card.tokens")}
            valueText={`${kfmt(goal.tokensUsed)}/${kfmt(goal.config.maxTokens)}`}
            pct={pct(goal.tokensUsed, goal.config.maxTokens)}
            barClass={style.bar}
          />
        </div>

        {lastReason && (
          <p className="line-clamp-1 text-xs italic text-muted-foreground">
            {/* i18n-exempt: typographic quotation glyphs around user content, not copy */}
            &ldquo;{lastReason}&rdquo;
          </p>
        )}

        <div className="pt-0.5">{controls}</div>
      </div>
      <GoalDetailSheet goal={goal} open={open} onOpenChange={setOpen} />
    </article>
  )
}

function pct(used: number, max: number): number {
  if (max <= 0) return 0
  return Math.min(100, Math.max(0, (used / max) * 100))
}

function kfmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

function Meter({
  label,
  valueText,
  pct,
  barClass,
}: {
  label: string
  valueText: string
  pct: number
  barClass: string
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{valueText}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", barClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function Control({
  label,
  testId,
  onClick,
  children,
}: {
  label: string
  testId: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8 text-muted-foreground hover:text-foreground"
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

ActiveGoalCard.displayName = "ActiveGoalCard"
