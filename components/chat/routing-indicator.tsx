"use client"

// Compact routing explainability chip on assistant messages (ADR-0043 Phase
// 12): shows which alias/tier an auto-routed turn landed on, with the full
// reason trail in a tooltip. Renders nothing for manual selections — a pinned
// model is its own explanation. `showRoutingIndicator` gates it in
// message-shell; the data comes from `buildRoutingRunMetadata`.

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { MessageRunMetadata } from "@/lib/chat/message-run-metadata"

export interface RoutingIndicatorProps {
  routing: NonNullable<MessageRunMetadata["routing"]>
}

export function RoutingIndicator({ routing }: RoutingIndicatorProps) {
  const t = useTranslations("chat.messageDisplay.routing")
  // Reason codes share their labels with the routing workbench.
  const tRoot = useTranslations("providers.routingView")

  if (routing.mode === "manual") return null

  const costCapExceeded = routing.reasonCodes.includes("cost-cap-exceeded")
  const label =
    routing.mode === "auto"
      ? t("auto", { target: routing.alias ?? routing.tier ?? "auto" })
      : t("alias", { alias: routing.alias ?? "alias" })

  // Same templated-code handling as the routing test panel: `plugin:x:y` and
  // `filter:x` interpolate their own key; everything else is a literal code.
  const localizeReasonCode = (code: string): string => {
    if (code.startsWith("plugin:")) return tRoot("reasonCode.plugin", { code })
    if (code.startsWith("filter:")) return tRoot("reasonCode.filter", { code })
    return tRoot(`reasonCode.${code}` as never)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          data-testid="routing-indicator"
          className={cn(
            "h-5 cursor-help px-1.5 text-[10px] font-normal",
            costCapExceeded && "text-amber-600 dark:text-amber-400"
          )}
        >
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-0.5 text-xs">
          <p>{t("strategy", { strategy: routing.strategy })}</p>
          {routing.tier !== undefined && <p>{t("tier", { tier: routing.tier })}</p>}
          {routing.score !== undefined && <p>{t("score", { score: routing.score.toFixed(2) })}</p>}
          {routing.judgeUsed !== undefined && (
            <p>{t("judgeUsed", { value: routing.judgeUsed ? t("yes") : t("no") })}</p>
          )}
          <p>{t("candidates", { count: routing.candidateCount })}</p>
          {routing.reasonCodes.map((code) => (
            <p key={code}>{localizeReasonCode(code)}</p>
          ))}
          {costCapExceeded && (
            <p className="text-amber-600 dark:text-amber-400">{t("costCapExceeded")}</p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
