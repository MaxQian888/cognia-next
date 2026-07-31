"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { listLoopEvents } from "@/lib/db/loops"
import type { Loop, LoopEvent } from "@/types/loop"
import { cn } from "@/lib/utils"

interface Props {
  loop: Loop
}

type LoopT = ReturnType<typeof useTranslations>

const KIND_ICON: Record<LoopEvent["kind"], string> = {
  loop_created: "🔁",
  iteration_started: "▶️",
  iteration_completed: "✔️",
  delay_decided: "⏲️",
  delay_parse_failed: "⚠️",
  exit_triggered: "🛑",
  user_paused: "⏸️",
  user_resumed: "▶️",
  user_stopped: "⏹️",
  config_updated: "⚙️",
  interval_fired: "⏰",
}

export function LoopActivityTab({ loop }: Props) {
  const t = useTranslations("loop")
  const events = useLiveQuery(() => listLoopEvents(loop.id, 200), [loop.id])

  if (!events) {
    return <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="loop-activity-empty">
        {t("activity.empty")}
      </p>
    )
  }

  return (
    <ul className="space-y-2 text-sm" data-testid="loop-activity-list">
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

function summarisePayload(ev: LoopEvent, t: LoopT): string {
  const p = ev.payload
  switch (p.kind) {
    case "loop_created":
      return t("activity.loop_created", { iterations: p.config.maxIterations })
    case "iteration_started":
      return t("activity.iteration_started", { n: p.iteration })
    case "iteration_completed":
      return t("activity.iteration_completed", { n: p.iteration, tokens: p.tokensDelta })
    case "delay_decided":
      return t("activity.delay_decided", {
        minutes: Math.max(1, Math.round(p.delayMs / 60_000)),
        reason: p.reason ?? t("activity.noReason"),
      })
    case "delay_parse_failed":
      return t("activity.delay_parse_failed", { n: p.failureCount })
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
    case "interval_fired":
      return t("activity.interval_fired", { n: p.iteration })
  }
}
