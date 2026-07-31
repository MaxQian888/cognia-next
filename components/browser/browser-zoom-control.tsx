"use client"

import { MinusIcon, PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Button } from "@/components/ui/button"

/** Discrete zoom stops the ± buttons step through; 1 (100%) is the default. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const
/** Absolute bounds — mirrors the Rust `clamp_zoom` backstop. */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 5

/** The next stop above `zoom`, or `zoom` unchanged if already at the top stop. */
export function zoomIn(zoom: number): number {
  return ZOOM_STEPS.find((step) => step > zoom + 1e-6) ?? zoom
}

/** The next stop below `zoom`, or `zoom` unchanged if already at the bottom stop. */
export function zoomOut(zoom: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < zoom - 1e-6) return ZOOM_STEPS[i]
  }
  return zoom
}

/**
 * Compact `[ − ] 100% [ + ]` zoom stepper. The percentage doubles as a
 * reset-to-100% button. Shared by the embedded and remote preview toolbars.
 */
export function BrowserZoomControl({
  zoom,
  onZoomChange,
  disabled,
}: {
  zoom: number
  onZoomChange: (zoom: number) => void
  disabled?: boolean
}) {
  const t = useTranslations("browser.zoom")
  const percent = Math.round(zoom * 100)
  const atMin = zoom <= ZOOM_STEPS[0] + 1e-6
  const atMax = zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 1e-6
  return (
    <div className="flex items-center" data-testid="browser-zoom-control">
      <TooltipIconButton
        tooltip={t("out")}
        aria-label={t("out")}
        disabled={disabled || atMin}
        onClick={() => onZoomChange(zoomOut(zoom))}
      >
        <MinusIcon />
      </TooltipIconButton>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-label={t("reset")}
        className="h-7 min-w-12 px-1 font-mono text-xs font-normal tabular-nums"
        onClick={() => onZoomChange(1)}
      >
        {t("level", { percent })}
      </Button>
      <TooltipIconButton
        tooltip={t("in")}
        aria-label={t("in")}
        disabled={disabled || atMax}
        onClick={() => onZoomChange(zoomIn(zoom))}
      >
        <PlusIcon />
      </TooltipIconButton>
    </div>
  )
}
