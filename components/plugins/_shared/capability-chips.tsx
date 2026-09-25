"use client"

/**
 * Capability chip group used everywhere a plugin's `capabilities[]`
 * array is summarized — marketplace card, plugin card, library row,
 * detail Sheet, discover sheet rows. Replaces 4 bespoke renderers.
 *
 * Honors a uniform `limit` (default 3) with an "+N more" overflow
 * badge. When `hoverable` is set, the overflow badge discloses every
 * capability (tooltip on hover, popover on tap — `PluginHint`) so the user
 * can inspect the full set without leaving the surface. It used to be a
 * hover-only HoverCard a phone could not open.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import { PluginHint } from "./plugin-hint"

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
          <PluginHint
            label={t("capabilityOverflow", { count: overflow })}
            side="bottom"
            align="start"
            contentClassName="w-72"
            content={
              <>
                <div className="mb-1 text-xs font-medium">
                  {t("capabilityCount", { count: capabilities.length })}
                </div>
                <div className="flex flex-wrap gap-1">
                  {capabilities.map((cap) => (
                    <Badge key={cap} variant={variant} className="text-xs">
                      {cap}
                    </Badge>
                  ))}
                </div>
              </>
            }
          >
            {overflowBadge}
          </PluginHint>
        ) : (
          overflowBadge
        ))}
    </div>
  )
}
