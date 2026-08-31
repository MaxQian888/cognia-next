"use client"

import { memo, useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Music } from "lucide-react"

import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerDurationDisplay,
  AudioPlayerElement,
  AudioPlayerMuteButton,
  AudioPlayerPlayButton,
  AudioPlayerSeekBackwardButton,
  AudioPlayerSeekForwardButton,
  AudioPlayerTimeDisplay,
  AudioPlayerTimeRange,
  AudioPlayerVolumeRange,
} from "@/components/ai-elements/audio-player"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { downloadFromUrl } from "@/lib/files/download"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"

interface AudioBlockProps {
  src: string
  title?: string
  artist?: string
  album?: string
  cover?: string
  className?: string
  autoPlay?: boolean
  loop?: boolean
  showDownload?: boolean
}

export const AudioBlock = memo(function AudioBlock({
  src,
  title,
  artist,
  album,
  cover,
  className,
  autoPlay = false,
  loop = false,
  showDownload = true,
}: AudioBlockProps) {
  const t = useTranslations("chat.renderers.audio")
  const [hasError, setHasError] = useState(false)

  const handleDownload = useCallback(async () => {
    try {
      await downloadFromUrl(src, title || t("defaultFilename"))
    } catch (err) {
      loggers.chat.warn("audio download failed", {
        err: err instanceof Error ? err.message : String(err),
        src,
      })
    }
  }, [src, title, t])

  if (hasError) {
    return (
      <div
        className={cn(
          "my-4 flex flex-col gap-3 rounded-lg border border-dashed bg-muted/30 p-4",
          className
        )}
      >
        <div className="flex items-center gap-4">
          <Music className="size-10 text-muted-foreground/50" />
          <div className="flex-1">
            <p className="text-sm text-muted-foreground">{t("failedToLoad")}</p>
            {title && <p className="text-xs text-muted-foreground/70">{title}</p>}
          </div>
        </div>
        {/* Native controls remain available when Media Chrome cannot decode or initialise. */}
        <audio className="w-full" controls src={src} aria-label={title ?? t("defaultFilename")} />
      </div>
    )
  }

  return (
    <div
      className={cn(
        "my-4 flex items-center gap-4 rounded-lg border bg-card p-4",
        // Reclaim 16px of chrome on a phone; see the control-bar note below for
        // why this card is width-critical.
        "max-sm:gap-3 max-sm:p-3",
        className
      )}
    >
      <div className="shrink-0">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt={title || t("coverAlt")}
            className="size-12 rounded-lg object-cover sm:size-16"
          />
        ) : (
          <div className="flex size-12 items-center justify-center rounded-lg bg-primary/10 sm:size-16">
            <Music className="size-6 text-primary sm:size-8" />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-0.5">
            {title && <p className="truncate text-sm font-medium">{title}</p>}
            {(artist || album) && (
              <p className="truncate text-xs text-muted-foreground">
                {artist}
                {artist && album && " • "}
                {album}
              </p>
            )}
          </div>
          {showDownload && (
            <TooltipIconButton
              aria-label={t("download")}
              onClick={handleDownload}
              size="icon"
              tooltip={t("download")}
              variant="ghost"
            >
              <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
            </TooltipIconButton>
          )}
        </div>

        <AudioPlayer className="w-full">
          <AudioPlayerElement
            aria-label={title ?? t("defaultFilename")}
            autoPlay={autoPlay}
            loop={loop}
            onError={() => setHasError(true)}
            src={src}
          />
          {/* The control group inside is a `w-fit` ButtonGroup: it sizes to its
              children and cannot shrink, so on a phone it ran past the card —
              the duration and mute controls were clipped off-screen entirely.
              Tighten each control's own padding below `sm` rather than dropping
              controls, so every affordance stays reachable on a narrow screen,
              and let the group take the full width so the seek range absorbs
              whatever is left. The volume slider beneath already uses this
              file's `hidden … sm:block` idiom; it is the one control with a
              real alternative (the mute button). */}
          <AudioPlayerControlBar
            className={cn(
              "w-full",
              "max-sm:[&_[data-slot=button-group]]:w-full max-sm:[&_[data-slot=button-group]]:min-w-0",
              "max-sm:[&_[data-slot=button-group]>*]:px-2",
              // Last resort for the narrowest phones (~320px), where even the
              // tightened row cannot fit: wrap instead of clipping, so the
              // controls that used to fall off the card are still reachable.
              "max-sm:[&_[data-slot=button-group]]:flex-wrap",
              // Vertical gap only: the group joins its children horizontally
              // with shared borders, and `gap-y` leaves that seam intact while
              // stopping the wrapped seek bar from sitting on the row above.
              "max-sm:[&_[data-slot=button-group]]:gap-y-2"
            )}
          >
            <AudioPlayerSeekBackwardButton aria-label={t("skipBack")} />
            <AudioPlayerPlayButton aria-label={t("playPause")} />
            <AudioPlayerSeekForwardButton aria-label={t("skipForward")} />
            <AudioPlayerTimeDisplay />
            {/* On a phone the seek bar takes its own full-width line and the
                transport buttons and readouts keep the first one — the layout
                every mobile player converges on, and the only arrangement here
                where nothing is dropped and nothing is clipped. `order-last`
                is what puts it after the readouts once it wraps; without it the
                wrap would strand the duration and mute controls on a third
                line instead. */}
            <AudioPlayerTimeRange className="min-w-10 flex-1 max-sm:order-last max-sm:basis-full sm:min-w-16" />
            <AudioPlayerDurationDisplay />
            <AudioPlayerMuteButton aria-label={t("mute")} />
            <AudioPlayerVolumeRange className="hidden w-20 sm:block" />
          </AudioPlayerControlBar>
        </AudioPlayer>
      </div>
    </div>
  )
})

export default AudioBlock
