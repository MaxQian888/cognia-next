"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { listGoalEvents } from "@/lib/db/goals"
import type { Goal, GoalEvent } from "@/types/goal"
import { cn } from "@/lib/utils"

interface Props {
  goal: Goal
}

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
}

export function GoalActivityTab({ goal }: Props) {
  const events = useLiveQuery(() => listGoalEvents(goal.id, 200), [goal.id])

  if (!events) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="goal-activity-empty">
        No activity yet.
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
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{summarisePayload(ev)}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

function summarisePayload(ev: GoalEvent): string {
  const p = ev.payload
  switch (p.kind) {
    case "goal_created":
      return `Created with ${p.config.maxTurns}-turn / ${p.config.maxTokens.toLocaleString()}-token budget`
    case "objective_updated":
      return "Objective replaced"
    case "turn_started":
      return `Turn ${p.turnNumber} started`
    case "turn_completed":
      return `Turn ${p.turnNumber} completed (${p.tokensDelta} tok)`
    case "judge_evaluated":
      return `done=${p.done} — ${p.reason}`
    case "judge_parse_failed":
      return `Parse failure #${p.failureCount}`
    case "exit_triggered":
      return `${p.exit} — ${p.reason}`
    case "user_paused":
      return "User paused"
    case "user_resumed":
      return "User resumed"
    case "user_stopped":
      return "User stopped"
    case "config_updated":
      return "Config updated"
  }
}
