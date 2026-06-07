"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { listGoalEvents } from "@/lib/db/goals"
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
}

export function GoalActivityTab({ goal }: Props) {
  const t = useTranslations("goal")
  const events = useLiveQuery(() => listGoalEvents(goal.id, 200), [goal.id])

  if (!events) {
    return <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="goal-activity-empty">
        {t("activity.empty")}
      </p>
    )
  }

  return (
    <ul className="space-y-2 text-sm" data-testid="goal-activity-list">
      {events.map((ev) => (
        <li
          key={ev.id}
          className={cn(
            "flex items-start gap-2 rounded-md border bg-card px-3 py-2",
            ev.kind === "exit_triggered" && "border-destructive/50"
          )}
        >
          <span aria-hidden>{KIND_ICON[ev.kind] ?? "•"}</span>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-mono">{ev.kind}</span>
              <span className="text-muted-foreground">{new Date(ev.ts).toLocaleTimeString()}</span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {summarisePayload(ev, t)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

function summarisePayload(ev: GoalEvent, t: GoalT): string {
  const p = ev.payload
  switch (p.kind) {
    case "goal_created":
      return t("activity.goal_created", {
        turns: p.config.maxTurns,
        tokens: p.config.maxTokens.toLocaleString(),
      })
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
      return t("activity.exit_triggered", { exit: p.exit, reason: p.reason })
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
        time: new Date(p.untilMs).toLocaleTimeString(),
        source: t(`pill.pacingReason.${p.source}`),
      })
  }
}
