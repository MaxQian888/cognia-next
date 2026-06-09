"use client"

// Richer attachment preview rendered above the textarea: image thumbs +
// file chips, each with a hover-only "X" to remove. Replaces the older
// inline `AttachmentChips` block in `composer.tsx`.

import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { cn } from "@/lib/utils"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { FileIcon, XIcon } from "lucide-react"
import { OcrMenu, isOcrEligible } from "./ocr-menu"

const IMAGE_PREFIX = "image/"

export interface AttachmentPreviewProps {
  /**
   * Optional handler — when supplied, image/PDF attachments grow a hover-only
   * OCR menu next to the remove button. Without a handler the menu is hidden
   * so the old behaviour is unchanged.
   */
  onOcrSelect?: (action: "extract-to-input" | "view-result", attachmentId: string) => void
  /** Disable the OCR menu trigger while a call is in flight. */
  ocrBusy?: boolean
}

export function AttachmentPreview(props: AttachmentPreviewProps = {}) {
  const t = useTranslations("chat.composer.attachments")
  const attachments = usePromptInputAttachments()
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  if (attachments.files.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-2 pt-2">
      <AnimatePresence initial={false}>
        {attachments.files.map((f) => {
          const isImage = (f.mediaType ?? "").startsWith(IMAGE_PREFIX)
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
                isImage ? "p-1" : "px-2 py-1.5"
              )}
            >
              {isImage && f.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.url} alt={displayName} className="size-14 rounded object-cover" />
              ) : (
                <>
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="max-w-[180px] truncate font-mono">
                    {f.filename ?? t("fallbackFile")}
                  </span>
                </>
              )}
              {showOcr ? (
                <div className="absolute right-7 top-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
                className="absolute top-0.5 right-0.5 size-5 rounded bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={t("removeAria", { filename: displayName })}
                tooltip={t("removeAria", { filename: displayName })}
              >
                <XIcon className="size-3" />
              </TooltipIconButton>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
