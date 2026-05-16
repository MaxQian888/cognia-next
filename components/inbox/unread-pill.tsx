"use client"

/**
 * Unread count pill.
 * Renders a red destructive Badge with the count when count > 0; renders
 * nothing when count === 0.
 */

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface UnreadPillProps {
  count: number
  className?: string
}

export function UnreadPill({ count, className }: UnreadPillProps) {
  const t = useTranslations("inbox.unreadPill")
  if (count <= 0) return null

  return (
    <Badge
      variant="destructive"
      className={cn(
        "h-4.5 min-w-[1.125rem] px-1 py-0 text-[10px] font-semibold leading-none",
        className
      )}
      aria-label={t("aria", { count })}
      data-testid="unread-pill"
    >
      {count > 99 ? "99+" : count}
    </Badge>
  )
}
