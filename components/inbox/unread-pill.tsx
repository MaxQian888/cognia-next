"use client"

/**
 * Unread count pill.
 * Renders a red dot + count when count > 0; renders nothing when count === 0.
 */

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

interface UnreadPillProps {
  count: number
  className?: string
}

export function UnreadPill({ count, className }: UnreadPillProps) {
  const t = useTranslations("inbox.unreadPill")
  if (count <= 0) return null

  return (
    <span
      className={cn(
        "inline-flex h-4.5 min-w-[1.125rem] items-center justify-center rounded-full",
        "bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground",
        className
      )}
      aria-label={t("aria", { count })}
      data-testid="unread-pill"
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}
