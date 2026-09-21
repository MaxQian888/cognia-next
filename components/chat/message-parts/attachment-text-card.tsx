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
import { AttachmentSourceActions } from "./attachment-source-actions"

export interface AttachmentTextCardProps {
  filename: string
  mediaType?: string
  /** The extracted text exactly as the model received it. */
  text: string
  sessionId?: string
  assetId?: string
}

export function AttachmentTextCard({
  filename,
  mediaType,
  text,
  sessionId,
  assetId,
}: AttachmentTextCardProps) {
  const t = useTranslations("chat.filePreview")
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  return (
    // Borderless quiet row, same language as the prompt-preamble strip it sits
    // beside in the user bubble: chevron + icon + name + count, the extracted
    // text expanding under a left rule rather than inside a boxed card.
    <div className="my-1 text-muted-foreground" data-testid="attachment-text-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-1 py-1 text-left text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <FileTextIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate" title={mediaType ? `${filename} · ${mediaType}` : filename}>
          {filename}
        </span>
        <span className="ms-auto shrink-0 tabular-nums text-[11px]">
          {t("extractedChars", { count: text.length })}
        </span>
      </button>
      {sessionId && assetId ? (
        <AttachmentSourceActions
          key={`${sessionId}:${assetId}`}
          sessionId={sessionId}
          assetId={assetId}
        />
      ) : null}
      {open ? (
        <pre
          id={bodyId}
          data-testid="attachment-text-card-body"
          className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words border-s-2 border-border bg-muted/30 ps-2 pe-1 py-1.5 font-mono text-[11px] leading-relaxed"
        >
          {text}
        </pre>
      ) : null}
    </div>
  )
}
