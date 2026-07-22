"use client"

import { memo, useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  Maximize2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useCopy } from "@/hooks/ui/use-copy"
import { downloadFromUrl } from "@/lib/files/download"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"

import { ImageLightbox, type ImageLightboxItem } from "./image-lightbox"

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
  const [activeIndex, setActiveIndex] = useState(0)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })
  const items = useMemo<ImageLightboxItem[]>(
    () => [{ id: src, src, alt, title }],
    [alt, src, title]
  )

  const handleDownload = useCallback(async () => {
    const filename = src.split("/").pop() || t("defaultFilename")
    try {
      await downloadFromUrl(src, filename, { fetchAsBlob: true })
    } catch (error) {
      loggers.chat.warn("image download failed, opening externally", {
        err: error instanceof Error ? error.message : String(error),
        src,
      })
      void openExternal(src)
    }
  }, [src, t])

  if (hasError) {
    return (
      <div
        className={cn(
          "my-4 flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 p-8",
          className
        )}
      >
        <ImageIcon className="mb-2 size-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t("failedToLoad")}</p>
        {alt ? <p className="mt-1 text-xs text-muted-foreground/70">{alt}</p> : null}
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => void openExternal(src)}>
          <ExternalLinkIcon className="mr-1 size-3" />
          {t("openUrl")}
        </Button>
      </div>
    )
  }

  return (
    <>
      <figure
        className={cn(
          "group relative my-4 inline-block max-w-full overflow-hidden rounded-lg",
          className
        )}
      >
        {isLoading ? <Skeleton className="absolute inset-0 size-full" /> : null}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          title={title}
          width={width}
          height={height}
          role="button"
          tabIndex={0}
          aria-label={t("viewFullscreen")}
          loading="lazy"
          onLoad={() => {
            setIsLoading(false)
            setHasError(false)
          }}
          onError={() => {
            setIsLoading(false)
            setHasError(true)
          }}
          className={cn(
            "h-auto max-w-full cursor-zoom-in rounded-lg transition-[opacity,transform] duration-300 group-hover:scale-[1.01]",
            isLoading && "opacity-0"
          )}
          onClick={(event) => {
            returnFocusRef.current = event.currentTarget
            setIsOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            returnFocusRef.current = event.currentTarget
            setIsOpen(true)
          }}
        />

        <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="size-7 bg-background/80 backdrop-blur-sm"
            onClick={(event) => {
              returnFocusRef.current = event.currentTarget
              setIsOpen(true)
            }}
            aria-label={t("viewFullscreen")}
            tooltip={t("viewFullscreen")}
          >
            <Maximize2Icon className="size-3" />
          </TooltipIconButton>
          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="size-7 bg-background/80 backdrop-blur-sm"
            onClick={() => void handleDownload()}
            aria-label={t("download")}
            tooltip={t("download")}
          >
            <DownloadIcon className="size-3" />
          </TooltipIconButton>
          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="size-7 bg-background/80 backdrop-blur-sm"
            onClick={() => void copy(src)}
            aria-label={t("copyUrl")}
            tooltip={t("copyUrl")}
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </TooltipIconButton>
        </div>

        {alt || title ? (
          <figcaption className="mt-2 px-2 text-center text-sm text-muted-foreground">
            {title || alt}
          </figcaption>
        ) : null}
      </figure>

      <ImageLightbox
        items={items}
        open={isOpen}
        activeIndex={activeIndex}
        returnFocusRef={returnFocusRef}
        onActiveIndexChange={setActiveIndex}
        onOpenChange={setIsOpen}
      />
    </>
  )
})

export default ImageBlock
