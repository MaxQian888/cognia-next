"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ActivityIcon, SquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { getPerformanceCaptureController } from "@/lib/perf/capture-controller"

const controller = getPerformanceCaptureController()

function captureSnapshot() {
  return controller.snapshot
}

export function PerfCaptureShellStatus({ className }: { className?: string }) {
  const t = useTranslations("performance.captures.shell")
  const router = useRouter()
  const state = useSyncExternalStore(
    controller.subscribe.bind(controller),
    captureSnapshot,
    captureSnapshot
  )
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    if (!state.active) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [state.active])

  if (!state.active || !state.captureId || !state.startedAt) return null

  const elapsedSeconds = Math.floor(Math.max(0, now - state.startedAt) / 1_000)

  return (
    <div
      role="status"
      data-testid="perf-capture-shell-status"
      className={className}
      aria-label={t("label")}
    >
      <ActivityIcon className="size-3.5 animate-pulse text-destructive" aria-hidden />
      <span className="truncate">
        {t("summary", {
          target: state.targetId,
          seconds: elapsedSeconds,
          gaps: state.gapCount,
        })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-[11px]"
        onClick={() => router.push("/performance")}
      >
        {t("return")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("stop")}
        disabled={stopping}
        onClick={() => {
          setStopping(true)
          void controller.stop("manual").finally(() => setStopping(false))
        }}
      >
        <SquareIcon aria-hidden />
      </Button>
    </div>
  )
}
