"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Maximize2Icon } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { mobileTransition } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { useMediaUrl } from "@/hooks/chat/use-media-url"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { ImageLightbox, type ImageLightboxItem } from "./image-lightbox"
import { useMessageImageCollection } from "./message-image-collection"

export interface MessageImageGalleryProps {
  items: ImageLightboxItem[]
  className?: string
}

const INITIAL_TILE_LIMIT = 12
const VIRTUAL_GRID_COLUMNS = 3
const VIRTUAL_GRID_ROW_HEIGHT = 140

interface GalleryThumbnailProps {
  item: ImageLightboxItem
  index: number
  multiple: boolean
  reduceMotion: boolean
  collection: ReturnType<typeof useMessageImageCollection>
  onResolved: (item: ImageLightboxItem | null) => void
  onOpen: (index: number, item: ImageLightboxItem, trigger: HTMLElement) => void
}

function GalleryThumbnail({
  item,
  index,
  multiple,
  reduceMotion,
  collection,
  onResolved,
  onOpen,
}: GalleryThumbnailProps) {
  const t = useTranslations("chat.renderers.image")
  const media = useMediaUrl(item.src, { thumbnail: true })
  const [canonicalRequested, setCanonicalRequested] = useState(false)
  const canonical = useMediaUrl(canonicalRequested ? item.src : null)
  const pendingTriggerRef = useRef<HTMLElement | null>(null)
  const isRef = media.status !== "inactive"
  const resolvedSrc = isRef ? media.url : item.src
  const lightboxSrc = canonical.status === "ready" ? canonical.url : resolvedSrc
  const resolvedItem = useMemo(
    () =>
      lightboxSrc
        ? { ...item, src: lightboxSrc, ...(isRef ? { sourceRef: item.src } : {}) }
        : null,
    [isRef, item, lightboxSrc]
  )
  const name = item.filename || item.title || item.alt || t("defaultTitle")

  useEffect(() => {
    onResolved(resolvedItem)
    return () => onResolved(null)
  }, [onResolved, resolvedItem])

  useEffect(() => {
    if (!collection || !resolvedItem) return
    return collection.register(resolvedItem)
  }, [collection, resolvedItem])

  useEffect(() => {
    const trigger = pendingTriggerRef.current
    if (!trigger || canonical.status !== "ready" || !resolvedItem) return
    pendingTriggerRef.current = null
    onOpen(index, resolvedItem, trigger)
  }, [canonical.status, index, onOpen, resolvedItem])

  return (
    <motion.button
      type="button"
      data-testid="message-image-thumbnail"
      aria-label={media.status === "missing" ? t("retry") : t("previewAria", { name })}
      onClick={(event) => {
        if (media.status === "missing") {
          media.retry()
          return
        }
        if (!isRef) {
          if (resolvedItem) onOpen(index, resolvedItem, event.currentTarget)
          return
        }
        if (canonical.status === "ready" && resolvedItem) {
          onOpen(index, resolvedItem, event.currentTarget)
          return
        }
        pendingTriggerRef.current = event.currentTarget
        setCanonicalRequested(true)
      }}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      whileHover={reduceMotion ? undefined : { scale: 1.015 }}
      whileTap={reduceMotion ? undefined : { scale: 0.985 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { ...mobileTransition("normal"), delay: Math.min(index * 0.035, 0.14) }
      }
      className={cn(
        "group/image relative overflow-hidden rounded-lg border bg-muted/30 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        multiple ? "aspect-square" : "max-h-72"
      )}
    >
      {resolvedSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolvedSrc}
          alt={item.alt ?? ""}
          loading="lazy"
          draggable={false}
          className={cn(
            "transition-transform duration-300 group-hover/image:scale-[1.025]",
            multiple ? "size-full object-cover" : "max-h-72 max-w-full object-contain"
          )}
        />
      ) : null}
      <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100 pointer-coarse:opacity-100">
        <Maximize2Icon className="size-3.5" aria-hidden />
      </span>
    </motion.button>
  )
}

function VirtualizedImageGrid({
  items,
  reduceMotion,
  collection,
  onResolved,
  onOpen,
}: {
  items: ImageLightboxItem[]
  reduceMotion: boolean
  collection: ReturnType<typeof useMessageImageCollection>
  onResolved: (id: string, item: ImageLightboxItem | null) => void
  onOpen: (index: number, item: ImageLightboxItem, trigger: HTMLElement) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowCount = Math.ceil(items.length / VIRTUAL_GRID_COLUMNS)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative measurement methods
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => VIRTUAL_GRID_ROW_HEIGHT,
    overscan: 2,
    initialRect: { width: 600, height: 480 },
  })

  return (
    <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto overscroll-contain">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const start = virtualRow.index * VIRTUAL_GRID_COLUMNS
          return (
            <div
              key={virtualRow.key}
              className="absolute left-0 top-0 grid w-full grid-cols-3 gap-2"
              style={{
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {items.slice(start, start + VIRTUAL_GRID_COLUMNS).map((item, lane) => {
                const index = start + lane
                return (
                  <GalleryThumbnail
                    key={item.id}
                    item={item}
                    index={index}
                    multiple
                    reduceMotion={reduceMotion}
                    collection={collection}
                    onResolved={(resolved) => onResolved(item.id, resolved)}
                    onOpen={onOpen}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function MessageImageGallery({ items, className }: MessageImageGalleryProps) {
  const t = useTranslations("chat.renderers.image")
  const reduceMotion = useReducedMotion() ?? false
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [lightboxItems, setLightboxItems] = useState<ImageLightboxItem[]>(items)
  const [showAllOpen, setShowAllOpen] = useState(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const resolvedItemsRef = useRef(new Map<string, ImageLightboxItem>())

  // Attachment images join the message-wide set so paging crosses freely
  // between them and any markdown / tool-result images in the same turn.
  const collection = useMessageImageCollection()
  const recordResolved = useCallback((id: string, item: ImageLightboxItem | null) => {
    if (item) resolvedItemsRef.current.set(id, item)
    else resolvedItemsRef.current.delete(id)
  }, [])

  if (items.length === 0) return null
  const multiple = items.length > 1
  const initialItems = items.slice(0, INITIAL_TILE_LIMIT)

  const openAt = (index: number, item: ImageLightboxItem, trigger: HTMLElement) => {
    setShowAllOpen(false)
    if (collection) {
      collection.open(item.src, trigger)
      return
    }
    returnFocusRef.current = trigger
    setLightboxItems(
      items.map((candidate) => resolvedItemsRef.current.get(candidate.id) ?? candidate)
    )
    setActiveIndex(index)
    setOpen(true)
  }

  return (
    <>
      <div
        role="group"
        aria-label={t("galleryAria", { count: items.length })}
        className={cn(multiple ? "grid max-w-sm grid-cols-2 gap-1.5" : "w-fit max-w-sm", className)}
      >
        {initialItems.map((item, index) => (
          <GalleryThumbnail
            key={item.id}
            item={item}
            index={index}
            multiple={multiple}
            reduceMotion={reduceMotion}
            collection={collection}
            onResolved={(resolved) => recordResolved(item.id, resolved)}
            onOpen={openAt}
          />
        ))}
      </div>

      {items.length > INITIAL_TILE_LIMIT ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setShowAllOpen(true)}
        >
          {t("showAllImages", { count: items.length })}
        </Button>
      ) : null}

      <Dialog open={showAllOpen} onOpenChange={setShowAllOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("allImagesTitle")}</DialogTitle>
            <DialogDescription>{t("galleryAria", { count: items.length })}</DialogDescription>
          </DialogHeader>
          <VirtualizedImageGrid
            items={items}
            reduceMotion={reduceMotion}
            collection={collection}
            onResolved={recordResolved}
            onOpen={openAt}
          />
        </DialogContent>
      </Dialog>

      {collection ? null : (
        <ImageLightbox
          items={lightboxItems}
          open={open}
          activeIndex={activeIndex}
          returnFocusRef={returnFocusRef}
          onActiveIndexChange={setActiveIndex}
          onOpenChange={setOpen}
        />
      )}
    </>
  )
}
