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
 * point of the bubble is the message they wrote around it. Drawn as the same
 * file card the composer showed for it before the send.
 */

import { useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon } from "lucide-react"

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
  type AttachmentData,
} from "@/components/ai-elements/attachments"
import { FileTypeBadge } from "@/components/shared/file-type-icon"
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
  // The AI Elements attachment primitives the composer's tiles build on, in
  // their `list` form: the same file card a staged document showed before it
  // was sent. The original's bytes are not on the part, so it carries no URL.
  const data = useMemo<AttachmentData>(
    () => ({ id: bodyId, type: "file", url: "", mediaType: mediaType ?? "", filename }),
    [bodyId, mediaType, filename]
  )

  return (
    <Attachments variant="list" className="my-1 w-full max-w-md">
      <Attachment
        data={data}
        className="flex-col items-stretch gap-0 overflow-hidden rounded-xl bg-card p-0 shadow-xs hover:bg-card"
        data-testid="attachment-text-card"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 p-2 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <AttachmentPreview
            className="size-auto rounded-none bg-transparent"
            fallbackIcon={<FileTypeBadge path={filename} className="size-10" />}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <AttachmentInfo
              className="text-xs font-medium"
              title={mediaType ? `${filename} · ${mediaType}` : filename}
            />
            <span className="text-[10.5px] leading-none text-muted-foreground tabular-nums">
              {t("extractedChars", { count: text.length })}
            </span>
          </span>
          <ChevronRightIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
            aria-hidden
          />
        </button>
        {sessionId && assetId ? (
          // Hidden while the source controls have nothing to say yet, so the
          // card never shows an empty bordered strip.
          <div className="border-t px-1.5 py-0.5 has-[>div:empty]:hidden">
            <AttachmentSourceActions
              key={`${sessionId}:${assetId}`}
              sessionId={sessionId}
              assetId={assetId}
            />
          </div>
        ) : null}
        {open ? (
          <pre
            id={bodyId}
            data-testid="attachment-text-card-body"
            className="max-h-80 overflow-auto border-t bg-muted/30 px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
          >
            {text}
          </pre>
        ) : null}
      </Attachment>
    </Attachments>
  )
}
