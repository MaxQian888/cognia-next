"use client"

import { useState, memo, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  ZoomIn,
  ZoomOut,
  Download,
  Copy,
  Check,
  Maximize2,
  X,
  ImageIcon,
  ExternalLink,
  RotateCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useCopy } from "@/hooks/ui/use-copy"
import { downloadFromUrl } from "@/lib/files/download"
import { loggers } from "@/lib/logging"

interface ImageBlockProps {
  src: string
  alt?: string
  title?: string
  className?: string
  width?: number
  height?: number
}

export const ImageBlock = memo(function ImageBlock({
  src,
  alt = "",
  title,
  className,
  width,
  height,
}: ImageBlockProps) {
  const t = useTranslations("chat.renderers.image")
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const handleLoad = useCallback(() => {
    setIsLoading(false)
    setHasError(false)
  }, [])

  const handleError = useCallback(() => {
    setIsLoading(false)
    setHasError(true)
  }, [])

  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + 0.25, 3))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - 0.25, 0.5))
  }, [])

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360)
  }, [])

  const handleResetView = useCallback(() => {
    setZoom(1)
    setRotation(0)
  }, [])

  const handleDownload = useCallback(async () => {
    const filename = src.split("/").pop() || t("defaultFilename")
    try {
      await downloadFromUrl(src, filename, { fetchAsBlob: true })
    } catch (err) {
      loggers.chat.warn("image download failed, opening in new tab", {
        err: err instanceof Error ? err.message : String(err),
        src,
      })
      window.open(src, "_blank")
    }
  }, [src, t])

  const handleCopyUrl = useCallback(async () => {
    await copy(src)
  }, [copy, src])

  const handleOpenExternal = useCallback(() => {
    window.open(src, "_blank")
  }, [src])

  if (hasError) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 p-8 my-4",
          className
        )}
      >
        <ImageIcon className="h-12 w-12 text-muted-foreground/50 mb-2" />
        <p className="text-sm text-muted-foreground">{t("failedToLoad")}</p>
        {alt && <p className="text-xs text-muted-foreground/70 mt-1">{alt}</p>}
        <Button variant="ghost" size="sm" className="mt-2" onClick={handleOpenExternal}>
          <ExternalLink className="h-3 w-3 mr-1" />
          {t("openUrl")}
        </Button>
      </div>
    )
  }

  return (
    <>
      <figure
        className={cn(
          "group relative rounded-lg overflow-hidden my-4 inline-block max-w-full",
          className
        )}
      >
        {isLoading && <Skeleton className="absolute inset-0 h-full w-full" />}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          title={title}
          width={width}
          height={height}
          loading="lazy"
          onLoad={handleLoad}
          onError={handleError}
          className={cn(
            "max-w-full h-auto rounded-lg cursor-zoom-in transition-opacity",
            isLoading && "opacity-0"
          )}
          onClick={() => setIsOpen(true)}
        />

        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="h-7 w-7 bg-background/80"
            onClick={() => setIsOpen(true)}
            aria-label={t("viewFullscreen")}
            tooltip={t("viewFullscreen")}
          >
            <Maximize2 className="h-3 w-3" />
          </TooltipIconButton>

          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="h-7 w-7 bg-background/80"
            onClick={handleDownload}
            aria-label={t("download")}
            tooltip={t("download")}
          >
            <Download className="h-3 w-3" />
          </TooltipIconButton>

          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="h-7 w-7 bg-background/80"
            onClick={handleCopyUrl}
            aria-label={t("copyUrl")}
            tooltip={t("copyUrl")}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </TooltipIconButton>
        </div>

        {(alt || title) && (
          <figcaption className="text-center text-sm text-muted-foreground mt-2 px-2">
            {title || alt}
          </figcaption>
        )}
      </figure>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          className="max-w-[95vw] max-h-[95vh] p-0 overflow-hidden"
          showCloseButton={false}
        >
          <DialogHeader className="absolute top-0 left-0 right-0 z-10 flex flex-row items-center justify-between p-3 bg-gradient-to-b from-black/60 to-transparent">
            <DialogTitle className="text-white text-sm truncate max-w-[60%]">
              {title || alt || t("defaultTitle")}
            </DialogTitle>
            <DialogDescription className="sr-only">{t("previewDescription")}</DialogDescription>
            <div className="flex items-center gap-1">
              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handleZoomOut}
                disabled={zoom <= 0.5}
                aria-label={t("zoomOut")}
                tooltip={t("zoomOut")}
              >
                <ZoomOut className="h-4 w-4" />
              </TooltipIconButton>

              <span className="text-white text-xs px-2 min-w-[3rem] text-center">
                {Math.round(zoom * 100)}%
              </span>

              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handleZoomIn}
                disabled={zoom >= 3}
                aria-label={t("zoomIn")}
                tooltip={t("zoomIn")}
              >
                <ZoomIn className="h-4 w-4" />
              </TooltipIconButton>

              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handleRotate}
                aria-label={t("rotate")}
                tooltip={t("rotate")}
              >
                <RotateCw className="h-4 w-4" />
              </TooltipIconButton>

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

              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handleOpenExternal}
                aria-label={t("openInNewTab")}
                tooltip={t("openInNewTab")}
              >
                <ExternalLink className="h-4 w-4" />
              </TooltipIconButton>

              <TooltipIconButton
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={() => setIsOpen(false)}
                aria-label={t("close")}
                tooltip={t("close")}
              >
                <X className="h-4 w-4" />
              </TooltipIconButton>
            </div>
          </DialogHeader>

          <div
            className="flex items-center justify-center bg-black/90 overflow-auto"
            style={{ height: "calc(95vh - 60px)" } as React.CSSProperties}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                handleResetView()
              }
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              className="max-w-none transition-transform duration-200"
              style={
                {
                  transform: `scale(${zoom}) rotate(${rotation}deg)`,
                } as React.CSSProperties
              }
              draggable={false}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
})

export default ImageBlock
