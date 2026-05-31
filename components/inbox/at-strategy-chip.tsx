"use client"

/**
 * @-response-strategy chip for the conversation header.
 *
 * Surfaces the adapter's `atResponseStrategy` so the operator can see at a
 * glance whether the bot replies to all messages, only when @-mentioned, or
 * only in direct chats. The default ("always") is the implicit behaviour, so we
 * render nothing for it — the chip only appears for the restrictive strategies.
 */

import { useTranslations } from "next-intl"
import { AtSignIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAdapterInstance } from "@/hooks/connectors/use-adapter-instance"

interface AtStrategyChipProps {
  adapterId: string
}

export function AtStrategyChip({ adapterId }: AtStrategyChipProps) {
  const t = useTranslations("inbox.atStrategy")
  const adapter = useAdapterInstance(adapterId)
  const strategy = adapter?.atResponseStrategy

  if (!strategy || strategy === "always") return null

  const label = t(strategy)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="hidden md:inline-flex items-center gap-1 text-xs"
          aria-label={t("aria", { strategy: label })}
          data-testid="at-strategy-chip"
        >
          <AtSignIcon className="size-3" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{t("tooltip", { strategy: label })}</TooltipContent>
    </Tooltip>
  )
}
