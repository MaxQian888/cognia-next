"use client"

/**
 * Stage 2 — what the user sees while capture runs, if they keep the Sheet open.
 *
 * The Sheet is *not* the primary surface here; the floating controller is,
 * because the user is about to go and use another application. So this stage's
 * job is mostly to make that fact obvious: it says recording continues if the
 * panel is hidden, and it repeats the shortcuts that work from anywhere.
 *
 * The live region is polite rather than assertive — a screen-reader user
 * performing a workflow does not want every click read back over what they are
 * actually doing.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Circle, Pause, Play, Square, Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { scopeSummary } from "@/lib/skills/recording/types"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import { useRecorderPhase, useRecorderUsage } from "@/hooks/skills/use-skill-recorder"

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = String(Math.floor(total / 60)).padStart(2, "0")
  const seconds = String(total % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

interface Props {
  onPause: () => void
  onResume: () => void
  onUndo: () => void
  onFinish: () => void
  onHide: () => void
}

export function StageRecording({ onPause, onResume, onUndo, onFinish, onHide }: Props) {
  const t = useTranslations("skills.recorder")
  const phase = useRecorderPhase()
  const usage = useRecorderUsage()
  const stepCount = useRecorderStore((state) => state.capturedSteps.length)
  const ignoredCount = useRecorderStore((state) => state.ignoredCount)
  const startedAt = useRecorderStore((state) => state.startedAt)
  const scope = useRecorderStore((state) => state.scope)

  const paused = phase === "paused"
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!startedAt || paused) return
    const tick = () => setElapsed(Date.now() - startedAt)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [startedAt, paused])

  const worst = usage.reduce<{ percent: number; kind: string } | null>((acc, entry) => {
    if (entry.limit <= 0) return acc
    const percent = Math.round((entry.used / entry.limit) * 100)
    return !acc || percent > acc.percent ? { percent, kind: entry.kind } : acc
  }, null)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Circle
          aria-hidden
          className={cn(
            "size-3 shrink-0 fill-current",
            paused ? "text-muted-foreground" : "animate-pulse text-destructive"
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" aria-live="polite">
            {paused
              ? t("recording.paused", { count: stepCount })
              : t("recording.live", { count: stepCount })}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {scope ? t("recording.scope", { scope: scopeSummary(scope) }) : null}
            {startedAt ? ` · ${t("recording.elapsed", { time: formatElapsed(elapsed) })}` : null}
          </p>
        </div>
      </div>

      {worst && worst.percent >= 80 ? (
        <div className="space-y-1">
          <Progress
            value={worst.percent}
            aria-label={t(`recording.limitWarning`, {
              kind: worst.kind,
              percent: worst.percent,
            })}
          />
          <p className="text-xs text-muted-foreground">
            {t("recording.limitWarning", { kind: worst.kind, percent: worst.percent })}
          </p>
        </div>
      ) : null}

      {ignoredCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("recording.ignored", { count: ignoredCount })}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {paused ? (
          <Button size="sm" onClick={onResume}>
            <Play className="size-4" aria-hidden />
            {t("recording.resume")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onPause}>
            <Pause className="size-4" aria-hidden />
            {t("recording.pause")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onUndo} disabled={stepCount === 0}>
          <Undo2 className="size-4" aria-hidden />
          {t("recording.undo")}
        </Button>
        <Button size="sm" variant="destructive" onClick={onFinish}>
          <Square className="size-4" aria-hidden />
          {t("recording.finish")}
        </Button>
      </div>

      <div className="flex flex-col gap-1 border-y py-3">
        <Button size="sm" variant="ghost" onClick={onHide} className="px-2">
          {t("recording.hideSheet")}
        </Button>
        <p className="px-2 text-xs text-muted-foreground">{t("recording.hideSheetHint")}</p>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("recording.shortcuts", {
          pause: "Ctrl+Alt+Space",
          undo: "Ctrl+Alt+Backspace",
          finish: "Ctrl+Alt+Enter",
        })}
      </p>
    </div>
  )
}
