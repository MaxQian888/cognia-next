"use client"

/**
 * The reply target staged for this composer's next send (ADR-0177, batch 2).
 *
 * Sits in the context chip row with the attachments and `@` references,
 * because it is the same kind of thing: something the turn carries that has
 * no form in the typed text. Reads and clears the NAMED pane's target through
 * `useComposerSessionId`, so a split view never shows one pane's quote over
 * the other.
 */

import { useTranslations } from "next-intl"
import { CornerUpLeftIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useChatStore, useComposerReplyTo } from "@/stores/chat"
import { useComposerSessionId } from "./composer-session-context"

export interface ReplyToChipProps {
  /** Render the chip alone, for a parent that owns the row layout. */
  bare?: boolean
}

export function ReplyToChip({ bare = false }: ReplyToChipProps = {}) {
  const t = useTranslations("chat.replyTo")
  const composerSessionId = useComposerSessionId()
  const replyTo = useComposerReplyTo(composerSessionId)
  const setReplyTo = useChatStore((state) => state.setReplyTo)

  if (!replyTo) return null
  const preview = replyTo.preview.trim() || t("emptyPreview")
  const chip = (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs"
      )}
      title={preview}
      data-testid="composer-reply-to-chip"
    >
      <CornerUpLeftIcon className="size-3 shrink-0 text-primary" aria-hidden />
      <span className="shrink-0 text-muted-foreground">{t("chipLabel")}</span>
      <span className="max-w-[min(280px,calc(100vw-8rem))] truncate">{preview}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("clear")}
        onClick={() => setReplyTo(null, composerSessionId)}
        className="size-5 opacity-60 transition-opacity hover:opacity-100"
        data-testid="composer-reply-to-clear"
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  )
  if (bare) return chip
  return <div className="flex flex-wrap gap-1.5 px-2 pt-2">{chip}</div>
}
