"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  ImageIcon,
  RotateCwIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"

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
import { useMediaUrl } from "@/hooks/chat/use-media-url"
import { loggers } from "@cognia/logging"

export interface ImageLightboxItem {
  id: string
  src: string
  /** Stable content-addressed source used to fetch the canonical variant. */
  sourceRef?: string
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
  /**
   * Extra buttons rendered in the header before the close button (e.g. the
   * composer's "Model view" audit entry). Message rendering leaves it unset.
   */
  headerActions?: ReactNode
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

// Gesture tuning — calibrated against a real trackpad. Trackpad pinch arrives
// as wheel+ctrlKey in Chromium; a two-finger horizontal swipe is wheel deltaX.
const PINCH_WHEEL_RATE = 0.002 // zoom multiplier per wheel deltaY unit
const PINCH_WHEEL_CAP = 50 // ctrl+wheel notch guard (raw delta can be ~100)
const SWIPE_THRESHOLD = 320 // px of horizontal travel to flip an item
const SWIPE_COOLDOWN_MS = 500 // min gap between flips
const SWIPE_GAP_MS = 160 // pause this long = new swipe, reset the accumulator
const SWIPE_AXIS_RATIO = 2.2 // deltaX must dominate deltaY by this much
const PULL_DEAD_ZONE = 10 // px before the image starts following the pointer
const PULL_COMMIT_PX = 140 // release past this to dismiss
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4

interface LightboxViewProps {
  item: ImageLightboxItem
  canGoPrevious: boolean
  canGoNext: boolean
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
  reduceMotion: boolean
  headerActions?: ReactNode
}

function LightboxView({
  item,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  onClose,
  reduceMotion,
  headerActions,
}: LightboxViewProps) {
  const t = useTranslations("chat.renderers.image")
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [pullY, setPullY] = useState(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ startDistance: number; startZoom: number } | null>(null)
  const panStartRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const zoomRef = useRef(1)
  const navRef = useRef({ onPrevious, onNext })
  const swipeAcc = useRef(0)
  const swipeLast = useRef(0)
  const swipeCooldown = useRef(0)

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    navRef.current = { onPrevious, onNext }
  })

  // Wheel gestures need a non-passive listener: ctrl+wheel must preventDefault
  // to keep the browser's own page zoom out of the gesture.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault()
        const d = Math.max(-PINCH_WHEEL_CAP, Math.min(PINCH_WHEEL_CAP, e.deltaY))
        setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * Math.exp(-d * PINCH_WHEEL_RATE))))
        return
      }
      const now = performance.now()
      if (now - swipeLast.current > SWIPE_GAP_MS) swipeAcc.current = 0
      swipeLast.current = now
      if (zoomRef.current > 1) {
        // Zoomed: two fingers pan the image.
        e.preventDefault()
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
        return
      }
      if (Math.abs(e.deltaX) > 10 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * SWIPE_AXIS_RATIO) {
        swipeAcc.current += e.deltaX
        if (Math.abs(swipeAcc.current) > SWIPE_THRESHOLD && now >= swipeCooldown.current) {
          if (swipeAcc.current > 0) navRef.current.onNext()
          else navRef.current.onPrevious()
          swipeAcc.current = 0
          swipeCooldown.current = now + SWIPE_COOLDOWN_MS
        }
      } else {
        swipeAcc.current = 0
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const pinchDistance = useCallback(() => {
    const pointers = [...pointersRef.current.values()]
    if (pointers.length < 2) return 0
    return Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y)
  }, [])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Right-click drags are not gestures; and presses that began on a button
      // belong to the button — capturing the pointer would retarget its click
      // to the capture element and swallow the onClick entirely.
      if (event.button !== 0) return
      const target = event.target as Element
      if (target.closest("button")) return
      // Capture on the TARGET (not the stage): the gesture survives the pointer
      // crossing the header/filmstrip, while the target keeps receiving its own
      // click/dblclick (jsdom lacks setPointerCapture, hence the guard).
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(event.pointerId)
      }
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointersRef.current.size === 2) {
        pinchRef.current = { startDistance: pinchDistance(), startZoom: zoom }
        panStartRef.current = null
      } else {
        panStartRef.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
      }
    },
    [pinchDistance, zoom, pan.x, pan.y]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!pointersRef.current.has(event.pointerId)) return
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const pinch = pinchRef.current
      if (pinch && pointersRef.current.size >= 2 && pinch.startDistance > 0) {
        const ratio = pinchDistance() / pinch.startDistance
        setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.startZoom * ratio)))
        return
      }
      const start = panStartRef.current
      if (!start || pointersRef.current.size !== 1) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (zoomRef.current > 1) {
        setPan({ x: start.px + dx, y: start.py + dy })
      } else if (dy > PULL_DEAD_ZONE && dy > Math.abs(dx)) {
        // Pull-down to dismiss: the image follows the pointer below a small
        // dead zone; releasing past the commit distance closes the viewer.
        setPullY(dy - PULL_DEAD_ZONE)
      }
    },
    [pinchDistance]
  )

  const handlePointerEnd = useCallback(
    (event: React.PointerEvent) => {
      pointersRef.current.delete(event.pointerId)
      if (pointersRef.current.size < 2) pinchRef.current = null
      if (pointersRef.current.size === 0) {
        panStartRef.current = null
        if (pullY > PULL_COMMIT_PX) onClose()
        else setPullY(0)
      }
    },
    [onClose, pullY]
  )

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
    setPan({ x: 0, y: 0 })
    setPullY(0)
  }, [])

  return (
    <>
      {/* Floating chrome, not a solid bar: the header sits over the stage on
          a gradient scrim, same convention as the prototype and native photo
          viewers — controls appear where you look, the image keeps the full
          frame underneath. */}
      <DialogHeader className="pointer-events-none absolute inset-x-0 top-0 z-10 flex-row items-center justify-between gap-2 bg-gradient-to-b from-black/70 via-black/35 to-transparent px-3 pt-2 pb-7 text-left">
        <DialogTitle className="pointer-events-auto min-w-0 flex-1 truncate text-sm font-medium text-white">
          {itemName(item, t("defaultTitle"))}
        </DialogTitle>
        <DialogDescription className="sr-only">{t("previewDescription")}</DialogDescription>
        <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 overflow-x-auto">
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            onClick={() => setZoom((value) => Math.max(value - 0.25, MIN_ZOOM))}
            disabled={zoom <= MIN_ZOOM}
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
            onClick={() => setZoom((value) => Math.min(value + 0.25, MAX_ZOOM))}
            disabled={zoom >= MAX_ZOOM}
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
            <AnimatedActionIcon icon={AnimatedDownloadIcon} size={16} />
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
          {headerActions}
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
        ref={stageRef}
        className="relative flex min-h-0 items-center justify-center overflow-hidden bg-black/95 p-4 sm:p-8"
        data-testid="image-lightbox-stage"
        style={{ touchAction: "none" }}
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
            style={{
              transform: `translate(${pan.x}px, ${pan.y + pullY}px) scale(${zoom}) rotate(${rotation}deg)`,
            }}
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
  headerActions,
}: ImageLightboxProps) {
  const t = useTranslations("chat.renderers.image")
  const reduceMotion = useReducedMotion() ?? false
  const safeIndex = clampIndex(activeIndex, items.length)
  const activeItem = items[safeIndex]
  const adjacentIndex = safeIndex < items.length - 1 ? safeIndex + 1 : safeIndex - 1
  const adjacentItem = adjacentIndex >= 0 ? items[adjacentIndex] : undefined
  const activeCanonical = useMediaUrl(open ? activeItem?.sourceRef : null)
  // Keep exactly one neighbour warm. The hook owns and releases its object URL
  // with the dialog lifecycle, so a large gallery never pins every canonical.
  useMediaUrl(open ? adjacentItem?.sourceRef : null)
  if (!activeItem) return null
  const displayedItem =
    activeCanonical.status === "ready" && activeCanonical.url
      ? { ...activeItem, src: activeCanonical.url }
      : activeItem
  const select = (index: number) => onActiveIndexChange(clampIndex(index, items.length))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(92dvh,900px)] w-[min(96vw,1400px)] max-w-none grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden border-0 bg-black p-0 shadow-2xl"
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
            key={`${displayedItem.id}:${displayedItem.src}`}
            item={displayedItem}
            canGoPrevious={safeIndex > 0}
            canGoNext={safeIndex < items.length - 1}
            onPrevious={() => select(safeIndex - 1)}
            onNext={() => select(safeIndex + 1)}
            onClose={() => onOpenChange(false)}
            reduceMotion={reduceMotion}
            headerActions={headerActions}
          />
        </AnimatePresence>

        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 via-black/35 to-transparent px-3 pt-7 pb-2"
          data-testid="image-lightbox-thumbnails"
        >
          <div className="pointer-events-auto flex items-center justify-center gap-2 overflow-x-auto overscroll-x-contain">
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
