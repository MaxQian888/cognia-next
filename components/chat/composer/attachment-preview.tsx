"use client"

// Richer attachment preview rendered above the textarea: image thumbs +
// file chips, each with a hover-only "X" to remove. Replaces the older
// inline `AttachmentChips` block in `composer.tsx`.

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import {
  Attachments,
  type AttachmentData,
  getMediaCategory,
} from "@/components/ai-elements/attachments"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { ImageLightbox } from "@/components/chat/renderers/image-lightbox"
import { cn } from "@/lib/utils"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { FileIcon, XIcon } from "lucide-react"
import { OcrMenu, isOcrEligible } from "./ocr-menu"

export interface AttachmentPreviewProps {
  /**
   * Optional handler — when supplied, image/PDF attachments grow a hover-only
   * OCR menu next to the remove button. Without a handler the menu is hidden
   * so the old behaviour is unchanged.
   */
  onOcrSelect?: (action: "extract-to-input" | "view-result", attachmentId: string) => void
  /** Disable the OCR menu trigger while a call is in flight. */
  ocrBusy?: boolean
  /**
   * When true, render only the chips (no padded container) so a parent bar can
   * lay attachments and references out in a single flex flow. Defaults to the
   * standalone, self-contained row.
   */
  bare?: boolean
}

export function AttachmentPreview(props: AttachmentPreviewProps = {}) {
  const t = useTranslations("chat.composer.attachments")
  const tImage = useTranslations("chat.renderers.image")
  const attachments = usePromptInputAttachments()
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [activeImageIndex, setActiveImageIndex] = useState(0)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const imageItems = useMemo(
    () =>
      attachments.files.flatMap((file) => {
        const isImage = getMediaCategory(file as AttachmentData) === "image"
        if (!isImage || !file.url) return []
        const name = file.filename ?? t("fallbackName")
        return [{ id: file.id, src: file.url, alt: name, filename: file.filename }]
      }),
    [attachments.files, t]
  )
  const imageIndexById = useMemo(
    () => new Map(imageItems.map((item, index) => [item.id, index])),
    [imageItems]
  )
  if (attachments.files.length === 0) return null
  const chips = (
    <AnimatePresence initial={false}>
      {attachments.files.map((f) => {
        // Drive image-vs-file off the shared ai-elements media classifier so the
        // composer and the vendored primitive agree on what counts as an image.
        const isImage = getMediaCategory(f as AttachmentData) === "image"
        const displayName = f.filename ?? t("fallbackName")
        const showOcr = !!props.onOcrSelect && isOcrEligible(f.mediaType ?? null)
        return (
          <motion.div
            key={f.id}
            layout
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={transition}
            className={cn(
              "group relative flex items-center gap-2 overflow-hidden rounded-md border bg-muted/40 text-xs",
              isImage ? "size-20 p-1" : "px-2 py-1.5"
            )}
          >
            {isImage && f.url ? (
              <button
                type="button"
                aria-label={tImage("previewAria", { name: displayName })}
                className="relative size-full overflow-hidden rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                onClick={(event) => {
                  returnFocusRef.current = event.currentTarget
                  setActiveImageIndex(imageIndexById.get(f.id) ?? 0)
                  setLightboxOpen(true)
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={f.url}
                  alt={displayName}
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.035]"
                  draggable={false}
                />
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/65 to-transparent px-1.5 pb-1 pt-3 text-left text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
                  {displayName}
                </span>
              </button>
            ) : (
              <>
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="max-w-[180px] truncate font-mono">
                  {f.filename ?? t("fallbackFile")}
                </span>
              </>
            )}
            {showOcr ? (
              <div className="absolute right-7 top-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                <OcrMenu
                  attachmentId={f.id}
                  mediaType={f.mediaType ?? ""}
                  onSelect={props.onOcrSelect!}
                  disabled={props.ocrBusy}
                />
              </div>
            ) : null}
            <TooltipIconButton
              type="button"
              onClick={() => attachments.remove(f.id)}
              // Touch has no hover: without pointer-coarse the remove-X is
              // invisible on mobile and a staged attachment can't be removed.
              className="absolute top-0.5 right-0.5 size-5 rounded bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
              aria-label={t("removeAria", { filename: displayName })}
              tooltip={t("removeAria", { filename: displayName })}
            >
              <XIcon className="size-3" />
            </TooltipIconButton>
          </motion.div>
        )
      })}
    </AnimatePresence>
  )
  const lightbox = (
    <ImageLightbox
      items={imageItems}
      open={lightboxOpen}
      activeIndex={activeImageIndex}
      returnFocusRef={returnFocusRef}
      onActiveIndexChange={setActiveImageIndex}
      onOpenChange={setLightboxOpen}
    />
  )
  // Bare: raw chips with no container so a parent bar (e.g. context-chip-bar)
  // can lay attachments and references out in one flex flow. Standalone: wrap in
  // the vendored `Attachments` container (inline variant) plus our padded row.
  if (props.bare) {
    return (
      <>
        {chips}
        {lightbox}
      </>
    )
  }
  return (
    <>
      <Attachments variant="inline" className="px-2 pt-2">
        {chips}
      </Attachments>
      {lightbox}
    </>
  )
}
