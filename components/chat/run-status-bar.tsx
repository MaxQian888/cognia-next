"use client"

/**
 * `<RunStatusBar>` — the transient "what's happening right now" layer pinned
 * directly above the composer. It is the web analogue of the CLI's
 * `BottomStatus` (Codex's `StatusIndicatorWidget`): everything that only
 * matters while a turn is live, kept separate from the steady identity controls
 * in the composer's bottom toolbar.
 *
 *   ⟳ Working · 47s · Esc to interrupt      ← spinner + verb + active timer
 *     └ Bash: npm test                       ← live running-tool detail (≤ 3)
 *     💬 2 queued · ◆ reviewer   [Send now]  ← steer + subagent chips + B action
 *     • fix the failing test…                ← queued-steer preview
 *
 * Mounts only while the bound session has a live turn OR a queued steer;
 * renders nothing otherwise. The elapsed timer is the only stateful bit — it
 * ticks once a second and solely while busy, and reads the active-work clock
 * (`activeElapsedMs`) so it freezes during an approval wait.
 */
import { memo, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  useSessionMessages,
  useSessionRunTiming,
  useSessionStatus,
  useSessionSteerQueue,
} from "@/stores/chat"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  activeElapsedMs,
  formatRunElapsed,
  selectActiveToolLines,
  selectRunningSubagentChip,
} from "@/lib/claude/run-status"

/** How many queued steer messages to preview below the chips. */
const QUEUE_PREVIEW_MAX = 2

export interface RunStatusBarProps {
  /** Session this bar reports on (the bound pane's id). */
  sessionId: string | null
  /** Interrupt the running turn (same target as the composer's Stop). */
  onStop?: () => Promise<void> | void
  /** Interrupt and immediately replay the queued steer ("Send now" / B). */
  onSteerNow?: () => Promise<void> | void
  className?: string
}

function RunStatusBarImpl({ sessionId, onStop, onSteerNow, className }: RunStatusBarProps) {
  const t = useTranslations("chat.runStatus")
  const status = useSessionStatus(sessionId)
  const timing = useSessionRunTiming(sessionId)
  const steerQueue = useSessionSteerQueue(sessionId)
  const messages = useSessionMessages(sessionId)
  const subAgents = useSubagentRuntimeStore((s) => s.subAgents)

  const busy = status === "streaming" || status === "awaiting_approval"

  // Elapsed ticker — the interval mounts only while busy, so an idle pane never
  // ticks. The first sub-second of a fresh turn may read stale (clamped to 0s by
  // `activeElapsedMs`) until the first tick; this matches the subagent ticker
  // and keeps the effect free of synchronous set-state.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy])

  // Nothing live and nothing queued → render nothing.
  if (!busy && steerQueue.length === 0) return null

  const elapsedMs = activeElapsedMs(timing, status, now)
  const elapsed = elapsedMs != null ? formatRunElapsed(elapsedMs) : null
  const toolLines = busy ? selectActiveToolLines(messages, 3) : []
  const subagentChip = busy ? selectRunningSubagentChip(subAgents) : null
  const verb = status === "awaiting_approval" ? t("waitingApproval") : t("working")
  const queueDepth = steerQueue.length

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="run-status-bar"
      className={cn(
        "flex flex-col gap-1 border-t border-border/50 bg-background/60 px-3 py-1.5 text-xs",
        className
      )}
    >
      {busy && (
        <div className="flex items-center gap-2 text-foreground/80">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-500" aria-hidden />
          <span className="font-medium">{verb}</span>
          {elapsed && (
            <span className="tabular-nums text-muted-foreground" data-testid="run-status-elapsed">
              · {elapsed}
            </span>
          )}
          <button
            type="button"
            onClick={() => void onStop?.()}
            className="ml-auto text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("interruptHint")}
          </button>
        </div>
      )}

      {toolLines.map((line) => (
        <div
          key={line.id}
          className="truncate pl-5 font-mono text-[11px] text-muted-foreground"
          title={line.label}
        >
          └ {line.label}
        </div>
      ))}

      {(queueDepth > 0 || subagentChip) && (
        <div className="flex flex-wrap items-center gap-2 pl-5 text-[11px]">
          {queueDepth > 0 && (
            <span className="text-muted-foreground" data-testid="run-status-steer-chip">
              💬 {t("queued", { count: queueDepth })}
            </span>
          )}
          {subagentChip && (
            <span className="text-muted-foreground">
              ◆ {subagentChip.name}
              {subagentChip.count > 1 ? `×${subagentChip.count}` : ""}
            </span>
          )}
          {queueDepth > 0 && busy && onSteerNow && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-2 text-[11px]"
              aria-label={t("ariaSteerNow")}
              onClick={() => void onSteerNow()}
            >
              {t("steerNow")}
            </Button>
          )}
        </div>
      )}

      {steerQueue.slice(0, QUEUE_PREVIEW_MAX).map((entry, i) => (
        <div key={i} className="truncate pl-5 text-[11px] text-muted-foreground/80">
          • {entry.replace(/\s+/g, " ").trim()}
        </div>
      ))}
    </div>
  )
}

export const RunStatusBar = memo(RunStatusBarImpl)
