"use client"

import { useState, memo, useRef, useCallback, useEffect } from "react"
import { useTranslations } from "next-intl"
import { Volume2, VolumeX, Volume1, Music, SkipBack, SkipForward, Repeat } from "lucide-react"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { PauseIcon as AnimatedPauseIcon } from "@/components/ui/pause"
import { PlayIcon as AnimatedPlayIcon } from "@/components/ui/play"
import { cn, formatVideoTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { downloadFromUrl } from "@/lib/files/download"
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
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isLooping, setIsLooping] = useState(loop)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume
    }
  }, [volume])

  const handlePlayPause = useCallback(() => {
    if (!audioRef.current) return
    if (isPlaying) {
      audioRef.current.pause()
    } else {
      void audioRef.current.play()
    }
  }, [isPlaying])

  const handleTimeUpdate = useCallback(() => {
    if (!audioRef.current) return
    setCurrentTime(audioRef.current.currentTime)
  }, [])

  const handleLoadedMetadata = useCallback(() => {
    if (!audioRef.current) return
    setDuration(audioRef.current.duration)
    setIsLoading(false)
  }, [])

  const handleSeek = useCallback((value: number[]) => {
    if (!audioRef.current) return
    const time = value[0]
    audioRef.current.currentTime = time
    setCurrentTime(time)
  }, [])

  const handleVolumeChange = useCallback((value: number[]) => {
    const newVolume = value[0]
    setVolume(newVolume)
    setIsMuted(newVolume === 0)
  }, [])

  const handleMuteToggle = useCallback(() => {
    if (!audioRef.current) return
    if (isMuted) {
      audioRef.current.muted = false
      setIsMuted(false)
    } else {
      audioRef.current.muted = true
      setIsMuted(true)
    }
  }, [isMuted])

  const handleLoopToggle = useCallback(() => {
    if (!audioRef.current) return
    audioRef.current.loop = !isLooping
    setIsLooping(!isLooping)
  }, [isLooping])

  const handleSkipBack = useCallback(() => {
    if (!audioRef.current) return
    audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10)
  }, [])

  const handleSkipForward = useCallback(() => {
    if (!audioRef.current) return
    audioRef.current.currentTime = Math.min(duration, audioRef.current.currentTime + 10)
  }, [duration])

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

  const VolumeIcon = isMuted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  if (hasError) {
    return (
      <div
        className={cn(
          "flex items-center gap-4 rounded-lg border border-dashed bg-muted/30 p-4 my-4",
          className
        )}
      >
        <Music className="h-10 w-10 text-muted-foreground/50" />
        <div className="flex-1">
          <p className="text-sm text-muted-foreground">{t("failedToLoad")}</p>
          {title && <p className="text-xs text-muted-foreground/70">{title}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex items-center gap-4 rounded-lg border bg-card p-4 my-4", className)}>
      <audio
        ref={audioRef}
        src={src}
        autoPlay={autoPlay}
        loop={isLooping}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onError={() => setHasError(true)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />

      <div className="shrink-0">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt={title || t("coverAlt")}
            className="h-16 w-16 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary/10">
            <Music className="h-8 w-8 text-primary" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-2">
        <div className="space-y-0.5">
          {title && <p className="text-sm font-medium truncate">{title}</p>}
          {(artist || album) && (
            <p className="text-xs text-muted-foreground truncate">
              {artist}
              {artist && album && " • "}
              {album}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-10 text-right">
            {formatVideoTime(currentTime)}
          </span>
          <Slider
            value={[currentTime]}
            max={duration || 100}
            step={0.1}
            onValueChange={handleSeek}
            className="flex-1"
            disabled={isLoading}
          />
          <span className="text-xs text-muted-foreground w-10">{formatVideoTime(duration)}</span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleSkipBack}
              disabled={isLoading}
              aria-label={t("skipBack")}
              tooltip={t("skipBack")}
            >
              <SkipBack className="h-4 w-4" />
            </TooltipIconButton>

            <Button
              variant="default"
              size="icon"
              className="h-10 w-10 rounded-full"
              onClick={handlePlayPause}
              disabled={isLoading}
            >
              <AnimatedActionIcon
                icon={isPlaying ? AnimatedPauseIcon : AnimatedPlayIcon}
                size={20}
                animateOnChange={isPlaying}
                className={!isPlaying ? "ml-0.5" : undefined}
                data-state={isPlaying ? "pause" : "play"}
              />
            </Button>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleSkipForward}
              disabled={isLoading}
              aria-label={t("skipForward")}
              tooltip={t("skipForward")}
            >
              <SkipForward className="h-4 w-4" />
            </TooltipIconButton>
          </div>

          <div className="flex items-center gap-1">
            <div className="flex items-center gap-1">
              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleMuteToggle}
                aria-label={isMuted ? t("unmute") : t("mute")}
                tooltip={isMuted ? t("unmute") : t("mute")}
              >
                <VolumeIcon className="h-4 w-4" />
              </TooltipIconButton>
              <Slider
                value={[isMuted ? 0 : volume]}
                max={1}
                step={0.01}
                onValueChange={handleVolumeChange}
                className="w-20"
              />
            </div>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", isLooping && "text-primary")}
              onClick={handleLoopToggle}
              aria-label={t("loop")}
              tooltip={t("loop")}
            >
              <Repeat className="h-4 w-4" />
            </TooltipIconButton>

            {showDownload && (
              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleDownload}
                aria-label={t("download")}
                tooltip={t("download")}
              >
                <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
              </TooltipIconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

export default AudioBlock
