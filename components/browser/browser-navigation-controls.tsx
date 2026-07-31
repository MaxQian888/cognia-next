"use client"

import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"

export interface BrowserNavigationControlsProps {
  disabled?: boolean
  backDisabled?: boolean
  forwardDisabled?: boolean
  reloadDisabled?: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
}

/** Shared navigation chrome for embedded, remote, and iframe browser engines. */
export function BrowserNavigationControls({
  disabled = false,
  backDisabled = false,
  forwardDisabled = false,
  reloadDisabled = false,
  onBack,
  onForward,
  onReload,
}: BrowserNavigationControlsProps) {
  const t = useTranslations("browser.actions")

  return (
    <div className="flex shrink-0 items-center">
      <TooltipIconButton
        tooltip={t("back")}
        aria-label={t("back")}
        disabled={disabled || backDisabled}
        onClick={onBack}
      >
        <ArrowLeftIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={t("forward")}
        aria-label={t("forward")}
        disabled={disabled || forwardDisabled}
        onClick={onForward}
      >
        <ArrowRightIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={t("reload")}
        aria-label={t("reload")}
        disabled={disabled || reloadDisabled}
        onClick={onReload}
      >
        <RotateCwIcon />
      </TooltipIconButton>
    </div>
  )
}
