"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Maximize2Icon } from "lucide-react"

import { mobileTransition } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"

import { ImageLightbox, type ImageLightboxItem } from "./image-lightbox"
import { useMessageImageCollection } from "./message-image-collection"

export interface MessageImageGalleryProps {
  items: ImageLightboxItem[]
  className?: string
}

export function MessageImageGallery({ items, className }: MessageImageGalleryProps) {
  const t = useTranslations("chat.renderers.image")
  const reduceMotion = useReducedMotion() ?? false
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // Attachment images join the message-wide set so paging crosses freely
  // between them and any markdown / tool-result images in the same turn.
  const collection = useMessageImageCollection()
  useEffect(() => {
    if (!collection) return
    const unregister = items.map((item) => collection.register(item))
    return () => unregister.forEach((fn) => fn())
  }, [collection, items])

  if (items.length === 0) return null
  const multiple = items.length > 1

  const openAt = (index: number, trigger: HTMLElement) => {
    if (collection) {
      collection.open(items[index].src, trigger)
      return
    }
    returnFocusRef.current = trigger
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
        {items.map((item, index) => {
          const name = item.filename || item.title || item.alt || t("defaultTitle")
          return (
            <motion.button
              key={item.id}
              type="button"
              data-testid="message-image-thumbnail"
              aria-label={t("previewAria", { name })}
              onClick={(event) => openAt(index, event.currentTarget)}
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.src}
                alt={item.alt ?? ""}
                loading="lazy"
                draggable={false}
                className={cn(
                  "transition-transform duration-300 group-hover/image:scale-[1.025]",
                  multiple ? "size-full object-cover" : "max-h-72 max-w-full object-contain"
                )}
              />
              <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100 pointer-coarse:opacity-100">
                <Maximize2Icon className="size-3.5" aria-hidden />
              </span>
            </motion.button>
          )
        })}
      </div>

      {collection ? null : (
        <ImageLightbox
          items={items}
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
