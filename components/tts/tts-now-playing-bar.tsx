"use client"

/**
 * Global "now playing" bar for TTS playback.
 *
 * Single instance, mounted at the app client root. It is the ONLY component
 * that subscribes to the orchestrator's full progress stream — per-message
 * `ReadAloudButton`s use the lighter `useReadAloudStatus` selector so a
 * virtualized chat list doesn't re-render on every tick. Self-hides whenever
 * nothing is playing.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { SquareIcon, Volume2Icon } from "lucide-react"

import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { Button } from "@/components/ui/button"
import { PauseIcon as AnimatedPauseIcon } from "@/components/ui/pause"
import { PlayIcon as AnimatedPlayIcon } from "@/components/ui/play"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ttsOrchestrator, type TTSOrchestratorState } from "@/lib/tts/tts-orchestrator"
import { TTS_PROVIDERS } from "@cognia/tts/types"

export function TtsNowPlayingBar() {
  const t = useTranslations("tts.nowPlaying")
  const [state, setState] = useState<TTSOrchestratorState>(ttsOrchestrator.getState())

  useEffect(() => ttsOrchestrator.subscribe(setState), [])

  const { playbackState } = state
  const visible =
    playbackState === "loading" || playbackState === "playing" || playbackState === "paused"

  const providerName = TTS_PROVIDERS[state.currentProvider]?.name ?? state.currentProvider
  const pct = Math.round(Math.max(0, Math.min(1, state.progress)) * 100)

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.18 }}
          role="status"
          aria-label={t("title")}
          className="fixed bottom-4 left-1/2 z-50 flex w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border bg-background/95 px-3 py-2 shadow-lg backdrop-blur"
        >
          <Volume2Icon className="size-4 shrink-0 text-primary" />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs font-medium">{t("title")}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{providerName}</span>
            </div>
            <div
              className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-150"
                style={{ width: `${playbackState === "loading" ? 0 : pct}%` }}
              />
            </div>
          </div>

          {playbackState === "playing" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("pause")}
                  onClick={() => ttsOrchestrator.pause()}
                >
                  <AnimatedActionIcon icon={AnimatedPauseIcon} size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("pause")}</TooltipContent>
            </Tooltip>
          )}

          {playbackState === "paused" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("resume")}
                  onClick={() => ttsOrchestrator.resume()}
                >
                  <AnimatedActionIcon icon={AnimatedPlayIcon} size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("resume")}</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("stop")}
                onClick={() => ttsOrchestrator.stop()}
              >
                <SquareIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("stop")}</TooltipContent>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
