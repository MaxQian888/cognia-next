"use client"

/**
 * Capability chip group used everywhere a plugin's `capabilities[]`
 * array is summarized — marketplace card, plugin card, library row,
 * detail Sheet, discover sheet rows. Replaces 4 bespoke renderers.
 *
 * Honors a uniform `limit` (default 3) with an "+N more" overflow
 * badge. When `hoverable` is set, the overflow badge opens a
 * HoverCard listing every capability so the user can inspect the
 * full set without leaving the surface.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"

interface Props {
  capabilities: readonly string[]
  limit?: number
  hoverable?: boolean
  className?: string
  variant?: "outline" | "secondary"
}

export function CapabilityChips({
  capabilities,
  limit = 3,
  hoverable = true,
  className,
  variant = "outline",
}: Props) {
  const t = useTranslations("plugins.shared")
  if (!capabilities.length) return null
  const visible = capabilities.slice(0, limit)
  const overflow = capabilities.length - limit

  const overflowBadge = (
    <Badge variant={variant} className="text-xs" data-testid="capability-overflow">
      {t("capabilityOverflow", { count: overflow })}
    </Badge>
  )

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {visible.map((cap) => (
        <Badge key={cap} variant={variant} className="text-xs">
          {cap}
        </Badge>
      ))}
      {overflow > 0 &&
        (hoverable ? (
          <HoverCard openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                className="inline-flex"
                aria-label={t("capabilityOverflow", { count: overflow })}
              >
                {overflowBadge}
              </button>
            </HoverCardTrigger>
            <HoverCardContent className="w-72 p-3" align="start">
              <div className="text-xs font-medium mb-1">{capabilities.length} capabilities</div>
              <div className="flex flex-wrap gap-1">
                {capabilities.map((cap) => (
                  <Badge key={cap} variant={variant} className="text-xs">
                    {cap}
                  </Badge>
                ))}
              </div>
            </HoverCardContent>
          </HoverCard>
        ) : (
          overflowBadge
        ))}
    </div>
  )
}
