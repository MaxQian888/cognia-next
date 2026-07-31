"use client"

/**
 * Transcript card for a document the user attached.
 *
 * Attaching a PDF flattens it to text for the model. That same text used to be
 * rendered verbatim in the user's own bubble, so a 50-page report buried the
 * conversation under its full contents with no indication it was a file. This
 * renders the provenance instead — "📎 report.pdf · 12.3k chars" — and keeps the
 * text one click away.
 *
 * Collapsed by default: the user already knows what they attached, and the
 * point of the bubble is the message they wrote around it.
 */

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, FileTextIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export interface AttachmentTextCardProps {
  filename: string
  mediaType?: string
  /** The extracted text exactly as the model received it. */
  text: string
}

export function AttachmentTextCard({ filename, mediaType, text }: AttachmentTextCardProps) {
  const t = useTranslations("chat.filePreview")
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  return (
    <div className="my-1 overflow-hidden rounded-md border" data-testid="attachment-text-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
          aria-hidden
        />
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate" title={mediaType ? `${filename} · ${mediaType}` : filename}>
          {filename}
        </span>
        <span className="ms-auto shrink-0 tabular-nums text-[11px] text-muted-foreground">
          {t("extractedChars", { count: text.length })}
        </span>
      </button>
      {open ? (
        <pre
          id={bodyId}
          data-testid="attachment-text-card-body"
          className="max-h-80 overflow-auto border-t bg-muted/30 px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
        >
          {text}
        </pre>
      ) : null}
    </div>
  )
}
