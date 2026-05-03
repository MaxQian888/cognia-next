"use client"

// Decorator badge for marketplace cards / detail headers — shows whether a
// plugin's manifest has a verified publisher signature. Drives off the
// `signature` blob inside the manifest (set by the marketplace at install).

import { useTranslations } from "next-intl"
import { ShieldCheckIcon, ShieldAlertIcon, ShieldOffIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export type SignatureState = "verified" | "unverified" | "failed" | "unknown"

interface Props {
  state: SignatureState
  /** Optional signer label (publisher name) to render inside the tooltip. */
  signer?: string
  /** When `compact`, render only the icon (no text). */
  compact?: boolean
  className?: string
}

export function PluginSignatureBadge({ state, signer, compact, className }: Props) {
  const t = useTranslations("plugins.signature")
  const visual = (() => {
    switch (state) {
      case "verified":
        return {
          Icon: ShieldCheckIcon,
          variant: "secondary" as const,
          labelKey: "verified",
          tooltipKey: "verifiedTooltip",
        }
      case "failed":
        return {
          Icon: ShieldAlertIcon,
          variant: "destructive" as const,
          labelKey: "failed",
          tooltipKey: "failedTooltip",
        }
      case "unverified":
        return {
          Icon: ShieldOffIcon,
          variant: "outline" as const,
          labelKey: "unverified",
          tooltipKey: "unverifiedTooltip",
        }
      default:
        return {
          Icon: ShieldOffIcon,
          variant: "outline" as const,
          labelKey: "unknown",
          tooltipKey: "unknownTooltip",
        }
    }
  })()

  const { Icon, variant, labelKey, tooltipKey } = visual

  // Self-mounts a TooltipProvider so the badge works inside hosts that don't
  // wrap one (e.g., dialogs, isolated test renders). Production callers under
  // app/layout.tsx already have an outer provider; nested providers are fine
  // per Radix.
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={variant} className={className}>
            <Icon className="size-3" />
            {!compact && <span className="ml-1 text-xs">{t(labelKey as never)}</span>}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{t(tooltipKey as never)}</p>
          {signer && <p className="text-xs text-muted-foreground mt-0.5">{signer}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
