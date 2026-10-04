"use client"

/**
 * Grafana-style time-range picker: a trigger button showing the active range,
 * a popover with quick relative presets, and an absolute from/to section.
 *
 * Opening the popover seeds From/To from the ACTIVE custom range (a Dashboard
 * chart drill-down or a shared link pins one), so nudging a window by a few
 * minutes no longer means retyping both ends from blank fields. Apply is gated
 * on `isValidCustomRange`: a reversed or zero-width pair used to be accepted
 * and silently swapped downstream, producing a window nobody typed — now the
 * button stays disabled and the form says why.
 *
 * The trigger label truncates (a pinned absolute range is ~200px), so it also
 * carries the full text as its `title`; dates format in the APP locale.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ClockIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useObservabilityFormatters } from "@/hooks/observability/use-observability-formatters"
import { RANGE_PRESETS, isValidCustomRange, type RangePreset } from "@/lib/observability/time-range"

export interface TimeRangePickerProps {
  preset: RangePreset | "custom"
  customSince: number | null
  customUntil: number | null
  onPreset: (preset: RangePreset) => void
  onCustom: (since: number, until: number) => void
  /** Tighten the label's truncation cap — narrow toolbars only. A pinned
   * absolute range renders as "from → to", which is ~200px unclamped. */
  compact?: boolean
}

/** epoch ms → "YYYY-MM-DDTHH:mm" in local time for <input type=datetime-local>. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local string → epoch ms, or null when unparseable. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

export function TimeRangePicker({
  preset,
  customSince,
  customUntil,
  onPreset,
  onCustom,
  compact = false,
}: TimeRangePickerProps) {
  const t = useTranslations("observability.range")
  const fmt = useObservabilityFormatters()
  const [open, setOpen] = useState(false)
  const [fromStr, setFromStr] = useState("")
  const [toStr, setToStr] = useState("")

  const customWindow =
    preset === "custom" && customSince !== null && customUntil !== null
      ? { since: customSince, until: customUntil }
      : null
  const label = customWindow
    ? t("customLabel", {
        from: fmt.dateTime(customWindow.since),
        to: fmt.dateTime(customWindow.until),
      })
    : preset === "custom"
      ? t("custom")
      : t(`presets.${preset}`)

  const since = fromLocalInput(fromStr)
  const until = fromLocalInput(toStr)
  const valid = isValidCustomRange(since, until)
  // Only complain once both ends are filled in — an empty field is "not done
  // yet", not "wrong".
  const showOrderError = since !== null && until !== null && !valid

  const handleOpenChange = (next: boolean) => {
    // Seed on open (an event, not an effect): the fields always start from the
    // window on screen when there is an absolute one, and keep whatever the
    // user last typed otherwise.
    if (next && customWindow) {
      setFromStr(toLocalInput(customWindow.since))
      setToStr(toLocalInput(customWindow.until))
    }
    setOpen(next)
  }

  const choosePreset = (p: RangePreset) => {
    onPreset(p)
    setOpen(false)
  }

  const applyCustom = () => {
    if (!valid || since === null || until === null) return
    onCustom(since, until)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          data-testid="time-range-trigger"
          title={label}
        >
          <ClockIcon className="size-3.5" aria-hidden />
          <span className={cn("truncate", compact ? "max-w-[96px]" : "max-w-[220px]")}>
            {label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("quickRanges")}</p>
          <div className="grid grid-cols-3 gap-1.5">
            {RANGE_PRESETS.map((p) => (
              <Button
                key={p}
                variant={preset === p ? "default" : "outline"}
                size="sm"
                onClick={() => choosePreset(p)}
                data-testid={`range-preset-${p}`}
                className={cn("text-xs")}
              >
                {t(`presets.${p}`)}
              </Button>
            ))}
          </div>
        </div>
        <Separator />
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t("absolute")}</p>
          <div className="space-y-1">
            <Label htmlFor="obs-range-from" className="text-xs">
              {t("from")}
            </Label>
            <Input
              id="obs-range-from"
              type="datetime-local"
              value={fromStr}
              onChange={(e) => setFromStr(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="obs-range-to" className="text-xs">
              {t("to")}
            </Label>
            <Input
              id="obs-range-to"
              type="datetime-local"
              value={toStr}
              onChange={(e) => setToStr(e.target.value)}
              className="h-8 text-xs"
              aria-invalid={showOrderError || undefined}
              aria-describedby={showOrderError ? "obs-range-error" : undefined}
            />
          </div>
          {showOrderError && (
            <p
              id="obs-range-error"
              role="alert"
              className="text-xs text-destructive"
              data-testid="range-order-error"
            >
              {t("orderError")}
            </p>
          )}
          <Button
            size="sm"
            className="w-full"
            onClick={applyCustom}
            disabled={!valid}
            data-testid="range-apply-custom"
          >
            {t("apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
