"use client"

/**
 * Placeholder chip for images that are still being *prepared* — read, decoded
 * and downscaled by `prepareComposerAttachments` — and therefore do not exist
 * as staged attachments yet, so they have no chip of their own.
 *
 * That window had no representation in the context bar at all: the only
 * feedback was the send button swapping to a spinner, so dropping a 20MB photo
 * looked like nothing had happened for a second or two, and users re-dropped.
 * This chip occupies the gap and is replaced by the real attachment chips the
 * moment preparation settles.
 *
 * Images only, deliberately. Document preparation is comparatively instant and
 * the photo glyph would misdescribe a PDF; the send-button spinner still covers
 * that path.
 */

import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"

import { AnalyzingImage } from "@/components/loading-ui/analyzing-image"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"

export interface PreparingImagesChipProps {
  /** How many images are in flight. `0` renders nothing. */
  count: number
}

export function PreparingImagesChip({ count }: PreparingImagesChipProps) {
  const t = useTranslations("chat.composer.attachments")
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  const label = t("preparingImages", { count })

  // `<AnimatePresence>` is mounted unconditionally, for the same reason it is in
  // `attachment-preview`: gating it on `count` would unmount the presence
  // boundary along with the chip that is trying to leave, so the last chip would
  // pop instead of animating out.
  return (
    <AnimatePresence initial={false}>
      {count > 0 ? (
        <motion.div
          key="preparing-images"
          layout
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.85 }}
          transition={transition}
          // Dashed border, matching nothing else in the bar on purpose: this is
          // the one chip that is not yet a real attachment.
          className="flex h-8 select-none items-center gap-1.5 rounded-md border border-dashed border-border px-1.5 text-muted-foreground"
          data-testid="composer-preparing-images"
        >
          <AnalyzingImage label={label} className="size-4" />
          {/* The label is announced once, by the indicator's own status role —
              which carries the same string as its sr-only content. */}
          <span
            className="truncate text-xs font-medium"
            aria-hidden
            data-testid="composer-preparing-images-label"
          >
            {label}
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
