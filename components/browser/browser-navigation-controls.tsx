"use client"

import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon, SquareIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"

export interface BrowserNavigationControlsProps {
  disabled?: boolean
  backDisabled?: boolean
  forwardDisabled?: boolean
  reloadDisabled?: boolean
  /** A navigation is in flight: the reload button becomes stop. */
  loading?: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
  /**
   * Halt the in-flight navigation. Without it the button stays a reload while
   * loading, matching the old behaviour.
   */
  onStop?: () => void
}

/** Shared navigation chrome for embedded, remote, and iframe browser engines. */
export function BrowserNavigationControls({
  disabled = false,
  backDisabled = false,
  forwardDisabled = false,
  reloadDisabled = false,
  loading = false,
  onBack,
  onForward,
  onReload,
  onStop,
}: BrowserNavigationControlsProps) {
  const t = useTranslations("browser.actions")
  // Stop is the third state of the same button, the way every browser does it.
  // Without an `onStop` handler the caller has no way to halt a load, so the
  // button stays a reload rather than becoming a no-op that looks live.
  const stopping = loading && !!onStop

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
        tooltip={stopping ? t("stop") : t("reload")}
        aria-label={stopping ? t("stop") : t("reload")}
        disabled={disabled || (!stopping && reloadDisabled)}
        onClick={stopping ? onStop : onReload}
      >
        {stopping ? <SquareIcon /> : <RotateCwIcon />}
      </TooltipIconButton>
    </div>
  )
}
