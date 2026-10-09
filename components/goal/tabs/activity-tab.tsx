"use client"

import { useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { countGoalEvents, listGoalEvents } from "@/lib/db/goals"
import type { Goal, GoalEvent } from "@/types/goal"
import { cn } from "@/lib/utils"

interface Props {
  goal: Goal
}

/** Translator type for the goal namespace (next-intl `useTranslations` return). */
type GoalT = ReturnType<typeof useTranslations>

const KIND_ICON: Record<GoalEvent["kind"], string> = {
  goal_created: "🎯",
  objective_updated: "✏️",
  turn_started: "▶️",
  turn_completed: "✔️",
  judge_evaluated: "⚖️",
  judge_parse_failed: "⚠️",
  exit_triggered: "🛑",
  user_paused: "⏸️",
  user_resumed: "▶️",
  user_stopped: "⏹️",
  config_updated: "⚙️",
  subgoals_generated: "🧩",
  promise_requested: "🤝",
  promise_confirmed: "✅",
  promise_denied: "🙅",
  pacing_decided: "⏲️",
  acceptance_requested: "🔍",
  acceptance_resolved: "🏁",
  verification_requested: "🧪",
  verification_started: "▶️",
  verification_passed: "✅",
  verification_failed: "❌",
  verification_error: "⚠️",
  verification_disabled: "⏭️",
}

/** Events read per page; "Show more" adds another page. */
const ACTIVITY_PAGE = 200

export function GoalActivityTab({ goal }: Props) {
  const t = useTranslations("goal")
  const tRisk = useTranslations("policy.risk")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const [limit, setLimit] = useState({ goalId: goal.id, count: ACTIVITY_PAGE })
  const shown = limit.goalId === goal.id ? limit.count : ACTIVITY_PAGE
  const events = useLiveQuery(() => listGoalEvents(goal.id, shown), [goal.id, shown])
  const total = useLiveQuery(() => countGoalEvents(goal.id), [goal.id])

  if (!events) {
    return (
      <div className="space-y-3" aria-busy data-testid="goal-activity-loading">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="goal-activity-empty">
        {t("activity.empty")}
      </p>
    )
  }

  const more = total !== undefined && total > events.length

  return (
    <div className="space-y-3">
      {/* A timeline, not a stack of boxes: one hairline rail on the left, an
          icon per event on it, and the newest at the top. */}
      <ol className="relative space-y-3 border-l pl-4 text-sm" data-testid="goal-activity-list">
        {events.map((ev) => (
          <li key={ev.id} className="relative" data-kind={ev.kind}>
            <span
              aria-hidden
              className="absolute top-0 -left-[1.6rem] grid size-5 place-items-center rounded-full bg-background text-[11px]"
            >
              {KIND_ICON[ev.kind] ?? "•"}
            </span>
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={cn(
                  "text-xs font-medium",
                  ev.kind === "exit_triggered" && "text-destructive"
                )}
              >
                {t(`activity.kinds.${ev.kind}`)}
              </span>
              <time
                className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                dateTime={new Date(ev.ts).toISOString()}
                title={format.dateTime(new Date(ev.ts), {
                  dateStyle: "medium",
                  timeStyle: "medium",
                })}
              >
                {format.relativeTime(new Date(ev.ts), now)}
              </time>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {summarisePayload(ev, t, tRisk)}
            </p>
          </li>
        ))}
      </ol>
      {more ? (
        <div className="flex flex-col items-center gap-1 pt-1">
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {t("activity.shownOf", { shown: events.length, total })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLimit({ goalId: goal.id, count: shown + ACTIVITY_PAGE })}
            data-testid="goal-activity-more"
          >
            {t("activity.showMore")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function summarisePayload(ev: GoalEvent, t: GoalT, tRisk: GoalT): string {
  const p = ev.payload
  switch (p.kind) {
    case "goal_created": {
      const base = t("activity.goal_created", {
        turns: p.config.maxTurns,
        tokens: p.config.maxTokens.toLocaleString(),
      })
      // ADR-0070: when risk auto-raised this goal's ceremony, say which surfaces
      // did it. The classifier's own `reason` is English-only diagnostic text —
      // rebuild the summary from the localized surface labels instead.
      if (!p.risk) return base
      const surfaces = p.risk.surfaces
        .map((id) => tRisk(`surfaces.${id}.label`))
        .filter(Boolean)
        .join(", ")
      return `${base} · ${t("activity.riskGate", {
        tier: tRisk(`tier.${p.risk.tier}`),
        surfaces,
      })}`
    }
    case "objective_updated":
      return t("activity.objective_updated")
    case "turn_started":
      return t("activity.turn_started", { n: p.turnNumber })
    case "turn_completed":
      return t("activity.turn_completed", { n: p.turnNumber, tokens: p.tokensDelta })
    case "judge_evaluated":
      return t("activity.judge_evaluated", { done: String(p.done), reason: p.reason })
    case "judge_parse_failed":
      return t("activity.judge_parse_failed", { n: p.failureCount })
    case "exit_triggered":
      return t("activity.exit_triggered", {
        exit: t(`activity.exits.${p.exit}`),
        reason: p.reason,
      })
    case "user_paused":
      return t("activity.user_paused")
    case "user_resumed":
      return t("activity.user_resumed")
    case "user_stopped":
      return t("activity.user_stopped")
    case "config_updated":
      return t("activity.config_updated")
    case "subgoals_generated":
      return t("activity.subgoals_generated")
    case "promise_requested":
      return t("activity.promise_requested", { n: p.turnNumber })
    case "promise_confirmed":
      return t("activity.promise_confirmed", { n: p.turnNumber })
    case "promise_denied":
      return p.overridden
        ? t("activity.promise_denied_overridden", { n: p.denialCount })
        : t("activity.promise_denied", { n: p.denialCount })
    case "pacing_decided":
      return t("activity.pacing_decided", {
        time: new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(p.untilMs),
        source: t(`pill.pacingReason.${p.source}`),
      })
    case "acceptance_requested":
      return t("activity.acceptance_requested", { n: p.turnNumber })
    case "acceptance_resolved":
      return p.accepted
        ? t("activity.acceptance_accepted")
        : t("activity.acceptance_changes_requested")
    case "verification_requested":
      return t("activity.verification_requested", { attempt: p.attempt })
    case "verification_started":
      return t("activity.verification_started", { runId: p.workflowRunId })
    case "verification_passed":
      return t("activity.verification_passed", { attempt: p.attempt, summary: p.summary })
    case "verification_failed":
      return t("activity.verification_failed", { attempt: p.attempt, summary: p.summary })
    case "verification_error":
      return t("activity.verification_error", { error: p.error })
    case "verification_disabled":
      return t("activity.verification_disabled")
  }
}
