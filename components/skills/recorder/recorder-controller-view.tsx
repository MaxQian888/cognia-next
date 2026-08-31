"use client"

/**
 * The skill recorder's always-on-top controller strip.
 *
 * `src-tauri/src/recorder_window/mod.rs` opens a window at
 * `WebviewUrl::App("recorder-controller")`, but no such route existed, so every
 * recording ran behind a blank always-on-top strip. The Sheet is closed while
 * recording (`stage-recording.tsx`: "the Sheet is not the primary surface
 * here"), which made this the only surface the user had, and it showed nothing.
 *
 * The window's capability grants no `allow-close` and no `allow-hide`, so this
 * view must never offer a dismiss. Collapse is the only reduction available,
 * and even collapsed it keeps the elapsed time and a way back to the controls.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CircleIcon, PauseIcon, PlayIcon, SquareIcon, Undo2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  RECORDER_CONTROLLER_EVENT,
  onRecordEvent,
  recordPause,
  recordResume,
  recordStatus,
  recordStop,
  recordUndoLast,
  recorderControllerBeginDrag,
  recorderControllerSetCollapsed,
} from "@/lib/skills/recording/recorder-client"
import type { RecordStatus } from "@/lib/skills/recording/types"
import { isTauri } from "@/lib/tauri"

function formatElapsed(startedAt: number | undefined, now: number): string {
  if (!startedAt) return "0:00"
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

export function RecorderControllerView() {
  const t = useTranslations("skills.recorder.recording")
  const [status, setStatus] = useState<RecordStatus | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void recordStatus()
      .then(setStatus)
      .catch(() => {
        // A failed poll must not blank the strip. The last known status is
        // better than an empty always-on-top window over the user's work.
      })
  }, [])

  useEffect(() => {
    refresh()
    // The native channel drives step counts. The poll is the safety net for a
    // dropped event, not the primary source.
    const stopEvents = onRecordEvent(() => refresh())
    const poll = setInterval(refresh, 2000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      stopEvents()
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [refresh])

  useEffect(() => {
    if (!isTauri()) return
    let dispose: (() => void) | undefined
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<boolean>(RECORDER_CONTROLLER_EVENT, (event) => setCollapsed(Boolean(event.payload)))
      )
      .then((unlisten) => {
        dispose = unlisten
      })
      .catch(() => {})
    return () => dispose?.()
  }, [])

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } catch {
      // Swallow: the Sheet surfaces failures with full context. Throwing here
      // would leave an always-on-top strip showing a React error overlay.
    } finally {
      setBusy(false)
    }
  }, [])

  const paused = status?.phase === "paused"
  const elapsed = formatElapsed(status?.startedAt, now)

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed
    setCollapsed(next)
    void recorderControllerSetCollapsed(next).catch(() => setCollapsed(!next))
  }, [collapsed])

  if (collapsed) {
    return (
      <div
        data-testid="recorder-controller-collapsed"
        onPointerDown={() => void recorderControllerBeginDrag().catch(() => {})}
        className="bg-background/95 rounded-pill flex h-10 w-[120px] items-center gap-2 border px-3 shadow-lg backdrop-blur"
      >
        <CircleIcon
          className={cn(
            "size-2 shrink-0 fill-current",
            paused ? "text-muted-foreground" : "text-destructive"
          )}
        />
        <span className="font-mono text-xs tabular-nums">{elapsed}</span>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-6 shrink-0"
          aria-label={t("expand")}
          onClick={toggleCollapsed}
        >
          <PlayIcon className="size-3" />
        </Button>
      </div>
    )
  }

  return (
    <div
      data-testid="recorder-controller"
      onPointerDown={(event) => {
        // Only the strip itself drags. A pointer-down on a control must reach
        // the control.
        if ((event.target as HTMLElement).closest("button")) return
        void recorderControllerBeginDrag().catch(() => {})
      }}
      className="bg-background/95 flex h-14 w-[420px] items-center gap-3 rounded-xl border px-3 shadow-lg backdrop-blur"
      aria-label={t("moveController")}
    >
      <CircleIcon
        className={cn(
          "size-2.5 shrink-0 fill-current",
          paused ? "text-muted-foreground" : "text-destructive animate-pulse"
        )}
      />
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-xs leading-tight tabular-nums">{elapsed}</span>
        <span className="text-muted-foreground truncate text-[10px] leading-tight">
          {paused
            ? t("paused", { count: status?.stepCount ?? 0 })
            : t("live", { count: status?.stepCount ?? 0 })}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-label={paused ? t("resume") : t("pause")}
          onClick={() => void run(paused ? recordResume : recordPause)}
        >
          {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || (status?.stepCount ?? 0) === 0}
          aria-label={t("undo")}
          onClick={() => void run(recordUndoLast)}
        >
          <Undo2Icon className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          aria-label={t("finish")}
          onClick={() => void run(recordStop)}
        >
          <SquareIcon className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("collapse")}
          onClick={toggleCollapsed}
        >
          <span aria-hidden className="text-xs">
            –
          </span>
        </Button>
      </div>
    </div>
  )
}

export default RecorderControllerView
