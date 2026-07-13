"use client"

import { useState, memo, useRef, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Download,
  ExternalLink,
  VideoIcon,
} from "lucide-react"
import { cn, formatVideoTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { downloadFromUrl } from "@/lib/files/download"
import { openExternal } from "@/lib/tauri/opener"
import { loggers } from "@cognia/logging"

interface VideoBlockProps {
  src: string
  poster?: string
  title?: string
  className?: string
  autoPlay?: boolean
  loop?: boolean
  muted?: boolean
  controls?: boolean
}

function getYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#]+)/,
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

function getVimeoId(url: string): string | null {
  const match = url.match(/vimeo\.com\/(?:video\/)?(\d+)/)
  return match ? match[1] : null
}

function getBilibiliId(url: string): { bvid?: string; aid?: string } | null {
  const bvidMatch = url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/)
  if (bvidMatch) return { bvid: bvidMatch[1] }
  const aidMatch = url.match(/bilibili\.com\/video\/av(\d+)/)
  if (aidMatch) return { aid: aidMatch[1] }
  return null
}

export const VideoBlock = memo(function VideoBlock({
  src,
  poster,
  title,
  className,
  autoPlay = false,
  loop = false,
  muted = false,
  controls = true,
}: VideoBlockProps) {
  const t = useTranslations("chat.renderers.video")
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(autoPlay)
  const [isMuted, setIsMuted] = useState(muted)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  const youtubeId = getYouTubeId(src)
  const vimeoId = getVimeoId(src)
  const bilibiliId = getBilibiliId(src)
  const isEmbed = youtubeId || vimeoId || bilibiliId

  const handlePlayPause = useCallback(() => {
    if (!videoRef.current) return
    if (isPlaying) {
      videoRef.current.pause()
    } else {
      void videoRef.current.play()
    }
    setIsPlaying(!isPlaying)
  }, [isPlaying])

  const handleMuteToggle = useCallback(() => {
    if (!videoRef.current) return
    videoRef.current.muted = !isMuted
    setIsMuted(!isMuted)
  }, [isMuted])

  const handleFullscreen = useCallback(() => {
    if (!videoRef.current) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void videoRef.current.requestFullscreen()
    }
  }, [])

  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return
    setCurrentTime(videoRef.current.currentTime)
  }, [])

  const handleLoadedMetadata = useCallback(() => {
    if (!videoRef.current) return
    setDuration(videoRef.current.duration)
    setIsLoading(false)
  }, [])

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return
    const time = Number(e.target.value)
    videoRef.current.currentTime = time
    setCurrentTime(time)
  }, [])

  const handleDownload = useCallback(async () => {
    try {
      await downloadFromUrl(src, title || t("defaultFilename"))
    } catch (err) {
      loggers.chat.warn("video download failed", {
        err: err instanceof Error ? err.message : String(err),
        src,
      })
    }
  }, [src, title, t])

  const handleOpenExternal = useCallback(() => {
    // `window.open` is unreliable in the Capacitor WebView; openExternal routes
    // through the in-app browser (mobile) / OS browser (desktop).
    void openExternal(src)
  }, [src])

  if (hasError) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 p-8 my-4",
          className
        )}
        style={{ aspectRatio: "16/9" }}
      >
        <VideoIcon className="h-12 w-12 text-muted-foreground/50 mb-2" />
        <p className="text-sm text-muted-foreground">{t("failedToLoad")}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={handleOpenExternal}>
          <ExternalLink className="h-3 w-3 mr-1" />
          {t("openUrl")}
        </Button>
      </div>
    )
  }

  if (youtubeId) {
    return (
      <figure className={cn("my-4", className)}>
        <div className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "16/9" }}>
          <iframe
            src={`https://www.youtube.com/embed/${youtubeId}${autoPlay ? "?autoplay=1" : ""}`}
            title={title || t("youtubeTitle")}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        </div>
        {title && (
          <figcaption className="text-center text-sm text-muted-foreground mt-2">
            {title}
          </figcaption>
        )}
      </figure>
    )
  }

  if (vimeoId) {
    return (
      <figure className={cn("my-4", className)}>
        <div className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "16/9" }}>
          <iframe
            src={`https://player.vimeo.com/video/${vimeoId}${autoPlay ? "?autoplay=1" : ""}`}
            title={title || t("vimeoTitle")}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        </div>
        {title && (
          <figcaption className="text-center text-sm text-muted-foreground mt-2">
            {title}
          </figcaption>
        )}
      </figure>
    )
  }

  if (bilibiliId) {
    const bilibiliSrc = bilibiliId.bvid
      ? `https://player.bilibili.com/player.html?bvid=${bilibiliId.bvid}&autoplay=${autoPlay ? 1 : 0}`
      : `https://player.bilibili.com/player.html?aid=${bilibiliId.aid}&autoplay=${autoPlay ? 1 : 0}`
    return (
      <figure className={cn("my-4", className)}>
        <div className="relative rounded-lg overflow-hidden" style={{ aspectRatio: "16/9" }}>
          <iframe
            src={bilibiliSrc}
            title={title || t("bilibiliTitle")}
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        </div>
        {title && (
          <figcaption className="text-center text-sm text-muted-foreground mt-2">
            {title}
          </figcaption>
        )}
      </figure>
    )
  }

  return (
    <figure className={cn("my-4", className)}>
      <div className="relative rounded-lg overflow-hidden group bg-black">
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          autoPlay={autoPlay}
          loop={loop}
          muted={isMuted}
          playsInline
          className="w-full h-auto"
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onError={() => setHasError(true)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
          </div>
        )}

        {controls && !isLoading && (
          // Hover-revealed on fine pointers; always visible on touch (no hover
          // exists there, so play/seek/mute/fullscreen/download would otherwise
          // be completely unreachable — the video is unplayable on mobile).
          <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
            <div className="px-3">
              <input
                type="range"
                min={0}
                max={duration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-1 bg-white/30 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
              />
            </div>

            <div className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white hover:bg-white/20"
                  onClick={handlePlayPause}
                  aria-label={isPlaying ? t("pause") : t("play")}
                  tooltip={isPlaying ? t("pause") : t("play")}
                >
                  {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </TooltipIconButton>

                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white hover:bg-white/20"
                  onClick={handleMuteToggle}
                  aria-label={isMuted ? t("unmute") : t("mute")}
                  tooltip={isMuted ? t("unmute") : t("mute")}
                >
                  {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </TooltipIconButton>

                <span className="text-xs text-white">
                  {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
                </span>
              </div>

              <div className="flex items-center gap-1">
                {!isEmbed && (
                  <TooltipIconButton
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-white hover:bg-white/20"
                    onClick={handleDownload}
                    aria-label={t("download")}
                    tooltip={t("download")}
                  >
                    <Download className="h-4 w-4" />
                  </TooltipIconButton>
                )}

                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white hover:bg-white/20"
                  onClick={handleFullscreen}
                  aria-label={t("fullscreen")}
                  tooltip={t("fullscreen")}
                >
                  <Maximize className="h-4 w-4" />
                </TooltipIconButton>
              </div>
            </div>
          </div>
        )}
      </div>
      {title && (
        <figcaption className="text-center text-sm text-muted-foreground mt-2">{title}</figcaption>
      )}
    </figure>
  )
})

export default VideoBlock
