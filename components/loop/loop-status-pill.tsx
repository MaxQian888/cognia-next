"use client"

/**
 * Compact pill that surfaces the session's `/loop` just above the chat
 * composer — sibling of `GoalStatusPill`, composed from the same shared
 * `ActivityPill` primitive (which owns layout, truncation, the status
 * chip, and the mobile action collapse).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PauseIcon, PlayIcon, RepeatIcon, SearchIcon, SquareIcon } from "lucide-react"
import { ActivityPill, type ActivityPillAction } from "@/components/shared/activity-pill"
import { getLoopRuntime } from "@/lib/loop/runtime"
import type { Loop } from "@/types/loop"
import { useOpenLoop } from "./use-active-loop"
import { loopStatusStyle } from "./loop-status-style"
import { LoopDetailSheet } from "./loop-detail-sheet"

interface Props {
  sessionId: string | null
  /** Override hook output — used by tests and Storybook. */
  loopOverride?: Loop | null
  className?: string
}

export function LoopStatusPill({ sessionId, loopOverride, className }: Props) {
  const t = useTranslations("loop")
  const liveLoop = useOpenLoop(sessionId)
  const loop = loopOverride !== undefined ? loopOverride : (liveLoop ?? null)
  const [open, setOpen] = useState(false)

  if (!loop) return null

  const isActive = loop.status === "active"
  const isPaused = loop.status === "paused"
  const style = loopStatusStyle(loop.status)
  const subtext =
    loop.mode === "interval"
      ? t("pill.progressInterval", {
          iterations: loop.iterations,
          maxIterations: loop.config.maxIterations,
          minutes: Math.max(1, Math.round((loop.intervalMs ?? 0) / 60_000)),
        })
      : t("pill.progressSelfPaced", {
          iterations: loop.iterations,
          maxIterations: loop.config.maxIterations,
        })
  // Self-paced: surface the model's chosen delay + reason after iteration 1.
  const footnote =
    isActive && loop.mode === "self_paced" && loop.nextDelayMs
      ? t("pill.nextIteration", {
          minutes: Math.max(1, Math.round(loop.nextDelayMs / 60_000)),
          reason: loop.nextDelayReason ?? t("pill.noReason"),
        })
      : undefined

  const actions: ActivityPillAction[] = []
  if (isActive) {
    actions.push({
      id: "pause",
      icon: <PauseIcon />,
      label: t("pill.pause"),
      onClick: () => {
        void getLoopRuntime().pauseLoop(loop.id)
      },
      testId: "loop-pause-button",
      primary: true,
    })
  }
  if (isPaused) {
    actions.push({
      id: "resume",
      icon: <PlayIcon />,
      label: t("pill.resume"),
      onClick: () => {
        void getLoopRuntime().resumeLoop(loop.id)
      },
      testId: "loop-resume-button",
      primary: true,
    })
  }
  actions.push({
    id: "stop",
    icon: <SquareIcon />,
    label: t("pill.stop"),
    onClick: () => {
      void getLoopRuntime().stopLoop(loop.id)
    },
    testId: "loop-stop-button",
  })
  actions.push({
    id: "details",
    icon: <SearchIcon />,
    label: t("pill.details"),
    onClick: () => setOpen(true),
    testId: "loop-show-button",
  })

  return (
    <>
      <ActivityPill
        icon={<RepeatIcon className="size-4" aria-hidden />}
        title={loop.safePrompt}
        titleTooltip={loop.safePrompt}
        chip={{
          label: t(`status.${loop.status}`),
          chipClassName: style.chip,
          dotClassName: style.dot,
          pulse: style.pulse,
        }}
        subtext={subtext}
        footnote={footnote}
        actions={actions}
        ariaLabel={t("pill.ariaActiveLoop", { prompt: loop.safePrompt })}
        moreLabel={t("pill.moreActions")}
        className={className}
        data-testid="loop-status-pill"
      />
      <LoopDetailSheet loop={loop} open={open} onOpenChange={setOpen} />
    </>
  )
}

LoopStatusPill.displayName = "LoopStatusPill"
