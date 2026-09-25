"use client"

/**
 * "Installed" badge with optional desktop-only explanation. Replaces the
 * mismatched inline indicators in marketplace card, discover sheet
 * row, and library row. On Capacitor (mobile) the install action is
 * disabled, so this marker is also reused to explain why — through a
 * `PluginHint`, because the old hover-only Tooltip was exactly the
 * disclosure a phone cannot open.
 */

import { useTranslations } from "next-intl"
import { CheckIcon, InfoIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import { PluginHint } from "./plugin-hint"

interface Props {
  /** Render the desktop-only explanation instead of the success state. */
  desktopOnly?: boolean
  className?: string
  /** Override the default data-testid so callers can pin to a specific
   *  instance (used by surfaces that render multiple markers per row). */
  "data-testid"?: string
}

export function InstalledMarker({
  desktopOnly = false,
  className,
  "data-testid": dataTestId,
}: Props) {
  const t = useTranslations("plugins.shared")
  if (desktopOnly) {
    return (
      <PluginHint
        label={t("installedDesktopOnly")}
        content={<p>{t("installedDesktopOnlyHint")}</p>}
      >
        <Badge
          variant="outline"
          className={cn("text-xs gap-1", className)}
          data-testid={dataTestId ?? "installed-marker-desktop-only"}
        >
          <InfoIcon className="size-3" aria-hidden="true" />
          {t("installedDesktopOnly")}
        </Badge>
      </PluginHint>
    )
  }
  return (
    <Badge
      variant="secondary"
      className={cn("text-xs gap-1", className)}
      data-testid={dataTestId ?? "installed-marker"}
    >
      <CheckIcon className="size-3" aria-hidden="true" />
      {t("installed")}
    </Badge>
  )
}
