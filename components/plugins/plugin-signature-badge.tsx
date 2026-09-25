"use client"

// Decorator badge for marketplace cards / detail headers — shows whether a
// plugin's manifest has a verified publisher signature. Drives off the
// `signature` blob inside the manifest (set by the marketplace at install).
//
// The explanation is behind a `PluginHint` (focusable button, tooltip on
// hover, popover on tap). In `compact` mode the badge is a bare icon, so the
// trigger's accessible name carries the state ("Publisher signature:
// Unverified") that the icon alone cannot.

import { useTranslations } from "next-intl"
import { ShieldCheckIcon, ShieldAlertIcon, ShieldOffIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PluginHint } from "./_shared/plugin-hint"

export type SignatureState = "verified" | "unverified" | "failed" | "unknown"

interface Props {
  state: SignatureState
  /** Optional signer label (publisher name) to render inside the tooltip. */
  signer?: string
  /** When `compact`, render only the icon (no text). */
  compact?: boolean
  /** Classes for the focusable hint trigger that wraps the badge. */
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

  const stateLabel = t(labelKey as never)

  return (
    <PluginHint
      label={t("ariaLabel", { state: stateLabel })}
      className={className}
      testId="plugin-signature-hint"
      content={
        <>
          <p>{t(tooltipKey as never)}</p>
          {signer && <p className="text-muted-foreground">{signer}</p>}
        </>
      }
    >
      <Badge variant={variant}>
        <Icon className="size-3" aria-hidden />
        {!compact && <span className="ml-1 text-xs">{stateLabel}</span>}
      </Badge>
    </PluginHint>
  )
}
