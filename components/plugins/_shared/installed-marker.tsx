"use client"

/**
 * "Installed" badge with optional desktop-only tooltip. Replaces the
 * mismatched inline indicators in marketplace card, discover sheet
 * row, and library row. On Capacitor (mobile) the install action is
 * disabled, so this marker is also reused to explain why.
 */

import { useTranslations } from "next-intl"
import { CheckIcon, InfoIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

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
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn("text-xs gap-1", className)}
            data-testid={dataTestId ?? "installed-marker-desktop-only"}
          >
            <InfoIcon className="size-3" aria-hidden="true" />
            {t("installedDesktopOnly")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{t("installedDesktopOnly")}</TooltipContent>
      </Tooltip>
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
