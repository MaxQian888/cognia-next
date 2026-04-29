"use client"

import { useState, memo, useRef, useCallback, useEffect } from "react"
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Volume1,
  Download,
  Music,
  SkipBack,
  SkipForward,
  Repeat,
} from "lucide-react"
import { cn, formatVideoTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

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

  const handleDownload = useCallback(() => {
    const link = document.createElement("a")
    link.href = src
    link.download = title || "audio"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [src, title])

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
          <p className="text-sm text-muted-foreground">Failed to load audio</p>
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
            alt={title || "Album cover"}
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleSkipBack}
                  disabled={isLoading}
                >
                  <SkipBack className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>-10s</TooltipContent>
            </Tooltip>

            <Button
              variant="default"
              size="icon"
              className="h-10 w-10 rounded-full"
              onClick={handlePlayPause}
              disabled={isLoading}
            >
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
            </Button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleSkipForward}
                  disabled={isLoading}
                >
                  <SkipForward className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>+10s</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center gap-1">
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleMuteToggle}
                  >
                    <VolumeIcon className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isMuted ? "Unmute" : "Mute"}</TooltipContent>
              </Tooltip>
              <Slider
                value={[isMuted ? 0 : volume]}
                max={1}
                step={0.01}
                onValueChange={handleVolumeChange}
                className="w-20"
              />
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("h-8 w-8", isLooping && "text-primary")}
                  onClick={handleLoopToggle}
                >
                  <Repeat className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Loop</TooltipContent>
            </Tooltip>

            {showDownload && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleDownload}>
                    <Download className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Download</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

export default AudioBlock
