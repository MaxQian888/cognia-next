"use client"

/**
 * Renders the "you had attachments staged" reminder chips above the composer
 * after a draft is restored on session switch / reload.
 *
 * A draft now persists its attachment binaries, so most restored attachments
 * come back as real, sendable chips. This is the fallback for the ones that
 * could not: binaries evicted by the global draft quota, and drafts written
 * before binaries were saved at all. Informational only — it tells the user
 * which files to re-attach. Dismissable as a whole.
 */

import { useTranslations } from "next-intl"
import { PaperclipIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { formatBytes } from "@/lib/storage/usage"
import type { DraftAttachmentMeta } from "@/lib/db/chat-drafts"

export interface DraftRestoredAttachmentsProps {
  items: DraftAttachmentMeta[]
  onDismiss: () => void
}

export function DraftRestoredAttachments({ items, onDismiss }: DraftRestoredAttachmentsProps) {
  const t = useTranslations("chat.composer.draftRestore")
  if (items.length === 0) return null

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed bg-muted/40 px-2 py-1.5 text-xs"
      data-testid="draft-restored-attachments"
    >
      <span className="font-medium text-muted-foreground">{t("label")}</span>
      {items.map((item, i) => (
        <span
          key={`${item.name}-${i}`}
          className="inline-flex max-w-[14rem] items-center gap-1 rounded bg-background px-1.5 py-0.5"
        >
          <PaperclipIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{item.name}</span>
          {item.size > 0 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatBytes(item.size)}
            </span>
          ) : null}
        </span>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="ml-auto size-5"
        aria-label={t("dismiss")}
        onClick={onDismiss}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  )
}

export default DraftRestoredAttachments
