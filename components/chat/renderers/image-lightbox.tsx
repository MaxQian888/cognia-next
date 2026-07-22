"use client"

import { useCallback, useRef, useState, type RefObject } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  RotateCwIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { downloadFromUrl } from "@/lib/files/download"
import { openExternal } from "@/lib/tauri/opener"
import { mobileTransition } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"

export interface ImageLightboxItem {
  id: string
  src: string
  alt?: string
  title?: string
  filename?: string
}

export interface ImageLightboxProps {
  items: ImageLightboxItem[]
  open: boolean
  activeIndex: number
  returnFocusRef?: RefObject<HTMLElement | null>
  onActiveIndexChange: (index: number) => void
  onOpenChange: (open: boolean) => void
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0))
}

function itemName(item: ImageLightboxItem, fallback: string): string {
  return item.filename || item.title || item.alt || fallback
}

function canOpenExternally(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

interface LightboxViewProps {
  item: ImageLightboxItem
  canGoPrevious: boolean
  canGoNext: boolean
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
  reduceMotion: boolean
}

function LightboxView({
  item,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  onClose,
  reduceMotion,
}: LightboxViewProps) {
  const t = useTranslations("chat.renderers.image")
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ startDistance: number; startZoom: number } | null>(null)

  const pinchDistance = useCallback(() => {
    const pointers = [...pointersRef.current.values()]
    if (pointers.length < 2) return 0
    return Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y)
  }, [])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointersRef.current.size === 2) {
        pinchRef.current = { startDistance: pinchDistance(), startZoom: zoom }
      }
    },
    [pinchDistance, zoom]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!pointersRef.current.has(event.pointerId)) return
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const pinch = pinchRef.current
      if (pinch && pointersRef.current.size === 2 && pinch.startDistance > 0) {
        const ratio = pinchDistance() / pinch.startDistance
        setZoom(Math.min(3, Math.max(0.5, pinch.startZoom * ratio)))
      }
    },
    [pinchDistance]
  )

  const handlePointerEnd = useCallback((event: React.PointerEvent) => {
    pointersRef.current.delete(event.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
  }, [])

  const handleOpenExternal = useCallback(async () => {
    try {
      await openExternal(item.src)
    } catch (error) {
      loggers.chat.warn("image external open failed", {
        err: error instanceof Error ? error.message : String(error),
        src: item.src,
      })
    }
  }, [item.src])

  const handleDownload = useCallback(async () => {
    const filename = item.filename || item.src.split("/").pop() || t("defaultFilename")
    try {
      await downloadFromUrl(item.src, filename, { fetchAsBlob: true })
    } catch (error) {
      loggers.chat.warn("image download failed", {
        err: error instanceof Error ? error.message : String(error),
        src: item.src,
      })
      if (canOpenExternally(item.src)) void handleOpenExternal()
    }
  }, [handleOpenExternal, item, t])

  const resetView = useCallback(() => {
    setZoom(1)
    setRotation(0)
  }, [])

  return (
    <>
      <DialogHeader className="flex-row items-center justify-between gap-2 border-b border-white/10 bg-black/60 px-3 py-2 text-left">
        <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-white">
          {itemName(item, t("defaultTitle"))}
        </DialogTitle>
        <DialogDescription className="sr-only">{t("previewDescription")}</DialogDescription>
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto">
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            onClick={() => setZoom((value) => Math.max(value - 0.25, 0.5))}
            disabled={zoom <= 0.5}
            aria-label={t("zoomOut")}
            tooltip={t("zoomOut")}
          >
            <ZoomOutIcon className="size-4" />
          </TooltipIconButton>
          <span className="min-w-12 px-1 text-center text-xs tabular-nums text-white/80">
            {Math.round(zoom * 100)}%
          </span>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            onClick={() => setZoom((value) => Math.min(value + 0.25, 3))}
            disabled={zoom >= 3}
            aria-label={t("zoomIn")}
            tooltip={t("zoomIn")}
          >
            <ZoomInIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            onClick={() => setRotation((value) => (value + 90) % 360)}
            aria-label={t("rotate")}
            tooltip={t("rotate")}
          >
            <RotateCwIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            onClick={() => void handleDownload()}
            aria-label={t("download")}
            tooltip={t("download")}
          >
            <DownloadIcon className="size-4" />
          </TooltipIconButton>
          {canOpenExternally(item.src) ? (
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="hidden size-8 text-white hover:bg-white/15 hover:text-white sm:inline-flex"
              onClick={() => void handleOpenExternal()}
              aria-label={t("openInNewTab")}
              tooltip={t("openInNewTab")}
            >
              <ExternalLinkIcon className="size-4" />
            </TooltipIconButton>
          ) : null}
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            onClick={onClose}
            aria-label={t("close")}
            tooltip={t("close")}
          >
            <XIcon className="size-4" />
          </TooltipIconButton>
        </div>
      </DialogHeader>

      <div
        className="relative flex min-h-0 items-center justify-center overflow-auto bg-black/95 p-4 sm:p-8"
        data-testid="image-lightbox-stage"
        style={{ touchAction: "pan-x pan-y" }}
        onClick={(event) => {
          if (event.target === event.currentTarget) resetView()
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        {isLoading && !hasError ? <Skeleton className="absolute inset-8 rounded-xl" /> : null}
        {hasError ? (
          <div className="flex flex-col items-center gap-2 text-white/60" role="status">
            <ImageIcon className="size-12" />
            <span className="text-sm">{t("failedToLoad")}</span>
          </div>
        ) : (
          <motion.img
            data-testid="image-lightbox-active-image"
            src={item.src}
            alt={item.alt ?? ""}
            draggable={false}
            initial={reduceMotion ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: isLoading ? 0 : 1, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, scale: 0.97 }}
            transition={reduceMotion ? { duration: 0 } : mobileTransition("normal")}
            className="max-h-full max-w-full select-none object-contain"
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
            onLoad={() => setIsLoading(false)}
            onError={() => {
              setIsLoading(false)
              setHasError(true)
            }}
            onDoubleClick={() => setZoom((value) => (value === 1 ? 2 : 1))}
          />
        )}

        {canGoPrevious ? (
          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="absolute left-2 size-10 rounded-full bg-black/45 text-white backdrop-blur-sm hover:bg-black/65 sm:left-4"
            onClick={onPrevious}
            aria-label={t("previous")}
            tooltip={t("previous")}
          >
            <ChevronLeftIcon className="size-5" />
          </TooltipIconButton>
        ) : null}
        {canGoNext ? (
          <TooltipIconButton
            variant="secondary"
            size="icon"
            className="absolute right-2 size-10 rounded-full bg-black/45 text-white backdrop-blur-sm hover:bg-black/65 sm:right-4"
            onClick={onNext}
            aria-label={t("next")}
            tooltip={t("next")}
          >
            <ChevronRightIcon className="size-5" />
          </TooltipIconButton>
        ) : null}
      </div>
    </>
  )
}

export function ImageLightbox({
  items,
  open,
  activeIndex,
  returnFocusRef,
  onActiveIndexChange,
  onOpenChange,
}: ImageLightboxProps) {
  const t = useTranslations("chat.renderers.image")
  const reduceMotion = useReducedMotion() ?? false
  if (items.length === 0) return null

  const safeIndex = clampIndex(activeIndex, items.length)
  const activeItem = items[safeIndex]
  const select = (index: number) => onActiveIndexChange(clampIndex(index, items.length))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(92dvh,900px)] w-[min(96vw,1400px)] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-0 bg-black p-0 shadow-2xl"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return
          event.preventDefault()
          returnFocusRef.current.focus()
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && safeIndex > 0) {
            event.preventDefault()
            select(safeIndex - 1)
          } else if (event.key === "ArrowRight" && safeIndex < items.length - 1) {
            event.preventDefault()
            select(safeIndex + 1)
          } else if (event.key === "Home") {
            event.preventDefault()
            select(0)
          } else if (event.key === "End") {
            event.preventDefault()
            select(items.length - 1)
          }
        }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          <LightboxView
            key={activeItem.id}
            item={activeItem}
            canGoPrevious={safeIndex > 0}
            canGoNext={safeIndex < items.length - 1}
            onPrevious={() => select(safeIndex - 1)}
            onNext={() => select(safeIndex + 1)}
            onClose={() => onOpenChange(false)}
            reduceMotion={reduceMotion}
          />
        </AnimatePresence>

        <div
          className="border-t border-white/10 bg-black/75 px-3 py-2"
          data-testid="image-lightbox-thumbnails"
        >
          <div className="flex items-center justify-center gap-2 overflow-x-auto overscroll-x-contain">
            {items.map((item, index) => {
              const active = index === safeIndex
              const name = itemName(item, t("defaultTitle"))
              return (
                <motion.button
                  key={item.id}
                  type="button"
                  aria-label={t("selectImage", { name })}
                  aria-pressed={active}
                  onClick={() => select(index)}
                  whileHover={reduceMotion ? undefined : { y: -2 }}
                  whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                  transition={reduceMotion ? { duration: 0 } : mobileTransition("fast")}
                  className={cn(
                    "relative size-12 shrink-0 overflow-hidden rounded-md border-2 bg-white/5 outline-none transition-[border-color,opacity] focus-visible:ring-2 focus-visible:ring-white/70 sm:size-14",
                    active
                      ? "border-white opacity-100"
                      : "border-transparent opacity-55 hover:opacity-90"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.src} alt="" className="size-full object-cover" draggable={false} />
                </motion.button>
              )
            })}
            <span className="ml-1 shrink-0 text-xs tabular-nums text-white/65">
              {t("counter", { current: safeIndex + 1, total: items.length })}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
