"use client"

// A labelled numeric slider with a "reset to default" affordance and a tick
// marking the default position. Used across the appearance tabs (corner radius,
// line-height, letter-spacing) so every fine-tuning slider shares one
// interaction: a read-out of the current value, a default marker on the track,
// and a reset button that appears only once the value drifts from its default.
//
// The label text is passed in already-translated; only the reset control's
// aria-label is resolved here (appearance namespace) so callers stay terse.
//
// A drag is held locally and persisted once, on release (Radix
// `onValueCommit`; a keyboard step commits at once). Persisting per drag frame
// wrote the settings row dozens of times per gesture, and on a mirrored client
// — `/me/appearance` embeds these tabs on a paired phone — each write is its
// own queued `app_settings_update`, so one drag of the corner radius replayed
// every intermediate value onto the desktop.

import { RotateCcwIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { useSettingDraft } from "@/hooks/settings/use-setting-draft"
import { cn } from "@/lib/utils"

export interface SettingSliderRowProps {
  /** Already-translated label shown above the slider. */
  label: string
  value: number
  defaultValue: number
  min: number
  max: number
  step: number
  /**
   * Persist a value. Called once per gesture (slider release, keyboard step,
   * reset), never per drag frame. Return the save's promise: the row keeps
   * showing the dragged value until it resolves, so the thumb does not jump
   * back while the store catches up.
   */
  onChange: (value: number) => unknown
  /** Formats the numeric value for the read-out (e.g. `(v) => v.toFixed(3) + "rem"`). */
  format?: (value: number) => string
  /** Accessible name for the slider; defaults to `label`. */
  ariaLabel?: string
  className?: string
}

// Float-safe "is this still the default?" check — slider steps like 0.005 make
// exact equality unreliable after a round-trip through the DOM.
const EPSILON = 1e-6
const nearlyEqual = (a: number, b: number) => Math.abs(a - b) <= EPSILON

export function SettingSliderRow({
  label,
  value,
  defaultValue,
  min,
  max,
  step,
  onChange,
  format,
  ariaLabel,
  className,
}: SettingSliderRowProps) {
  const t = useTranslations("settings.appearance")
  const draft = useSettingDraft(value, onChange, { equals: nearlyEqual })
  const shown = draft.value
  const isModified = !nearlyEqual(shown, defaultValue)
  const readout = format ? format(shown) : String(shown)
  // Fraction of the track where the default sits, clamped to [0,1] so a stray
  // out-of-range default never paints the marker outside the track.
  const range = max - min
  const defaultFraction = range > 0 ? Math.min(1, Math.max(0, (defaultValue - min) / range)) : 0

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <div className="flex items-center gap-1">
          <span className="font-mono text-muted-foreground">{readout}</span>
          {isModified && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5 text-muted-foreground hover:text-foreground"
              aria-label={t("resetToDefault", { name: label })}
              title={t("resetToDefault", { name: label })}
              onClick={() => draft.commitValue(defaultValue)}
            >
              <RotateCcwIcon className="size-3" />
            </Button>
          )}
        </div>
      </div>
      <div className="relative">
        {/* Tick marking the default value so the user can see where "neutral" is. */}
        <span
          aria-hidden
          data-testid="default-marker"
          className="pointer-events-none absolute top-1/2 z-0 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-border"
          style={{ left: `${defaultFraction * 100}%` }}
        />
        <Slider
          min={min}
          max={max}
          step={step}
          value={[shown]}
          onValueChange={([next]) => draft.set(next)}
          onValueCommit={([next]) => draft.commitValue(next)}
          aria-label={ariaLabel ?? label}
        />
      </div>
    </div>
  )
}
