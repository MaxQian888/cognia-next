"use client"

/**
 * Compact "last inbound X ago" chip.
 *
 * Reads the newest `inbound.received` audit row for the conversation via
 * `useLastInboundForConversation`. Hides itself when no inbound has ever landed
 * (empty conversation) rather than showing a `Last message —` placeholder.
 *
 * Lifted out of `conversation-header.tsx` when the header's twenty controls
 * moved behind an overflow popover — it owns a 30s interval and four
 * pluralisation branches, so it earns its own file and suite.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLastInboundForConversation } from "@/hooks/connectors/use-last-inbound"

export function LastInboundChip({ conversationKey }: { conversationKey: string }) {
  const t = useTranslations("inbox.conversationHeader")
  const lastAt = useLastInboundForConversation(conversationKey)
  // Lazy init keeps Date.now() out of the render body; the interval re-ticks
  // the chip every 30s so "5 minutes ago" stays current without polluting
  // the render path with impure reads.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (lastAt === null) return null

  const ageMs = Math.max(0, now - lastAt)
  const label = (() => {
    const minutes = Math.round(ageMs / 60_000)
    if (minutes < 1) return t("lastInboundJustNow")
    if (minutes < 60) return t("lastInboundMinutes", { minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 48) return t("lastInboundHours", { hours })
    const days = Math.round(hours / 24)
    return t("lastInboundDays", { days })
  })()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* No `hidden md:inline-flex` any more — the overflow popover it now
            lives in is not width-constrained by the header strip. */}
        <Badge variant="outline" className="text-xs" data-testid="conversation-header-last-inbound">
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {t("lastInboundTooltip", { time: new Date(lastAt).toLocaleString() })}
      </TooltipContent>
    </Tooltip>
  )
}
