"use client"

// Richer attachment preview rendered above the textarea: image thumbs +
// file chips, each with a hover-only "X" to remove. Replaces the older
// inline `AttachmentChips` block in `composer.tsx`.

import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { cn } from "@/lib/utils"
import { FileIcon, XIcon } from "lucide-react"

const IMAGE_PREFIX = "image/"

export function AttachmentPreview() {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-2 pt-2">
      {attachments.files.map((f) => {
        const isImage = (f.mediaType ?? "").startsWith(IMAGE_PREFIX)
        return (
          <div
            key={f.id}
            className={cn(
              "group relative flex items-center gap-2 overflow-hidden rounded-md border bg-muted/40 text-xs",
              isImage ? "p-1" : "px-2 py-1.5"
            )}
          >
            {isImage && f.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={f.url}
                alt={f.filename ?? "attachment"}
                className="size-14 rounded object-cover"
              />
            ) : (
              <>
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="max-w-[180px] truncate font-mono">{f.filename ?? "file"}</span>
              </>
            )}
            <button
              type="button"
              onClick={() => attachments.remove(f.id)}
              className="absolute top-0.5 right-0.5 rounded bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              aria-label={`Remove ${f.filename ?? "attachment"}`}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
