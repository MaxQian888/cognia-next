"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, ImageIcon, Maximize2Icon } from "lucide-react"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"

import { Image } from "@/components/ai-elements/image"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useCopy } from "@/hooks/ui/use-copy"
import { useMediaUrl } from "@/hooks/chat/use-media-url"
import { downloadFromUrl } from "@/lib/files/download"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"

import { ImageLightbox, type ImageLightboxItem } from "./image-lightbox"
import { useMessageImageCollection } from "./message-image-collection"

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

  // `src` is either a `cognia-media:` reference into the content-addressed
  // store or a plain URL — a legacy inlined `data:` URL, or a remote one. The
  // hook stays inactive for the latter, which is what keeps messages written
  // before the store existed rendering unchanged.
  const media = useMediaUrl(src)
  const isRef = media.status !== "inactive"
  const resolvedSrc = isRef ? media.url : src
  // A reference the store cannot resolve is a real error (a failed migration,
  // an edited database); an unresolved plain URL is just a URL.
  const failed = hasError || media.status === "missing"
  // Referenced media knows its own dimensions, so the aspect box below is
  // reserved before a single byte is fetched.
  const boxWidth = width ?? (media.width || undefined)
  const boxHeight = height ?? (media.height || undefined)

  const items = useMemo<ImageLightboxItem[]>(
    () =>
      resolvedSrc
        ? [{ id: src, src: resolvedSrc, ...(isRef ? { sourceRef: src } : {}), alt, title }]
        : [],
    [alt, isRef, resolvedSrc, src, title]
  )

  // Inside a chat message every image joins ONE lightbox so the user can page
  // across the whole turn. Outside one (attachment preview sheet, dialogs,
  // settings) there is no provider and the local single-item lightbox below
  // stays in charge.
  const collection = useMessageImageCollection()
  useEffect(() => {
    if (!collection || !resolvedSrc) return
    // Registered under the original `src`, so the collection's identity is the
    // stable reference rather than an object URL that changes per resolution.
    return collection.register({
      id: src,
      src: resolvedSrc,
      ...(isRef ? { sourceRef: src } : {}),
      alt,
      title,
    })
  }, [collection, src, resolvedSrc, isRef, alt, title])

  const openViewer = useCallback(
    (trigger: HTMLElement | null) => {
      if (collection) {
        collection.open(src, trigger)
        return
      }
      returnFocusRef.current = trigger
      setIsOpen(true)
    },
    [collection, src]
  )

  const handleDownload = useCallback(async () => {
    if (!resolvedSrc) return
    // Name from the original `src`: an object URL carries no filename.
    const filename = src.split("/").pop() || t("defaultFilename")
    try {
      await downloadFromUrl(resolvedSrc, filename, { fetchAsBlob: true })
    } catch (error) {
      loggers.chat.warn("image download failed, opening externally", {
        err: error instanceof Error ? error.message : String(error),
        src,
      })
      void openExternal(resolvedSrc)
    }
  }, [resolvedSrc, src, t])

  if (failed) {
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
        {/* Only a plain URL can be opened outside the app; a store reference
            names local bytes and has nowhere to point a browser at. */}
        {isRef ? (
          <Button variant="ghost" size="sm" className="mt-2" onClick={media.retry}>
            {t("retry")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => void openExternal(src)}>
            <ExternalLinkIcon className="mr-1 size-3" />
            {t("openUrl")}
          </Button>
        )}
      </div>
    )
  }

  // A not-yet-loaded <img> without width/height attributes has an intrinsic
  // size of 0, so the figure collapsed and the `absolute inset-0` Skeleton had
  // nothing to fill — it was never actually visible, and the image popping in
  // shifted everything below it. Reserve the box: use the real aspect ratio
  // when the caller knows it (computer-use screenshots do), otherwise hold a
  // placeholder box until `onLoad` fires.
  const hasIntrinsicSize = Boolean(boxWidth && boxHeight)
  const reserveStyle = hasIntrinsicSize ? { aspectRatio: `${boxWidth} / ${boxHeight}` } : undefined
  // Still resolving a reference: nothing to point an <img> at yet, but the box
  // is already reserved from the stored dimensions.
  const pending = isLoading || resolvedSrc === null

  return (
    <>
      <figure
        style={reserveStyle}
        className={cn(
          "group relative my-4 inline-block max-w-full overflow-hidden rounded-lg",
          pending && !hasIntrinsicSize && "min-h-32 min-w-48",
          className
        )}
      >
        {pending ? <Skeleton className="absolute inset-0 size-full" /> : null}

        {resolvedSrc === null ? null : (
          <Image
            src={resolvedSrc}
            alt={alt}
            title={title}
            width={boxWidth}
            height={boxHeight}
            role="button"
            tabIndex={0}
            aria-label={t("viewFullscreen")}
            loading="lazy"
            decoding="async"
            onLoad={() => {
              setIsLoading(false)
              setHasError(false)
            }}
            onError={() => {
              setIsLoading(false)
              setHasError(true)
            }}
            className={cn(
              "cursor-zoom-in rounded-lg transition-[opacity,transform] duration-300 group-hover:scale-[1.01]",
              pending && "opacity-0"
            )}
            onClick={(event) => openViewer(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              openViewer(event.currentTarget)
            }}
          />
        )}

        <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="size-7 bg-background/80 backdrop-blur-sm"
            onClick={(event) => openViewer(event.currentTarget)}
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
            <AnimatedActionIcon icon={AnimatedDownloadIcon} size={12} />
          </TooltipIconButton>
          {/* A store reference is meaningless outside this app, and the object
              URL behind it dies with the document — neither is worth copying. */}
          {isRef ? null : (
            <TooltipIconButton
              variant="secondary"
              size="icon"
              className="size-7 bg-background/80 backdrop-blur-sm"
              onClick={() => void copy(src)}
              aria-label={t("copyUrl")}
              tooltip={t("copyUrl")}
            >
              <CopyFeedbackIcon copied={copied} size={12} />
            </TooltipIconButton>
          )}
        </div>

        {/* Only an explicit `title` is a caption. `alt` is ALTERNATIVE text —
            printing it under every markdown image turned screen-reader copy
            into visible chrome. It stays on the <img> for assistive tech. */}
        {title ? (
          <figcaption className="mt-2 px-2 text-center text-sm text-muted-foreground">
            {title}
          </figcaption>
        ) : null}
      </figure>

      {collection ? null : (
        <ImageLightbox
          items={items}
          open={isOpen}
          activeIndex={activeIndex}
          returnFocusRef={returnFocusRef}
          onActiveIndexChange={setActiveIndex}
          onOpenChange={setIsOpen}
        />
      )}
    </>
  )
})

export default ImageBlock
