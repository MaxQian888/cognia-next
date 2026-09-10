"use client"

/**
 * The line above the first message the reader has not seen (ADR-0177,
 * batch 2). Rendered by the message list inside the row wrapper of that
 * message, so the virtualizer measures it as part of the row and never
 * miscounts. Where the line goes is decided in `lib/chat/unread-marker.ts`.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

export function UnreadDivider({ className }: { className?: string }) {
  const t = useTranslations("chat.unreadDivider")
  return (
    <div
      role="separator"
      aria-label={t("label")}
      data-testid="unread-divider"
      className={cn("my-2 flex items-center gap-2 text-[11px] font-medium text-primary", className)}
    >
      <span className="h-px flex-1 bg-primary/40" aria-hidden />
      <span>{t("label")}</span>
      <span className="h-px flex-1 bg-primary/40" aria-hidden />
    </div>
  )
}
