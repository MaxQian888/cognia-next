"use client"

/**
 * Grafana-style time-range picker: a trigger button showing the active range,
 * a popover with quick relative presets, and an absolute from/to section.
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
import { RANGE_PRESETS, type RangePreset } from "@/lib/observability/time-range"
import { formatTimestamp } from "@/lib/observability/format-utils"

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
  const [open, setOpen] = useState(false)
  const [fromStr, setFromStr] = useState("")
  const [toStr, setToStr] = useState("")

  const label =
    preset === "custom"
      ? customSince !== null && customUntil !== null
        ? `${formatTimestamp(customSince)} → ${formatTimestamp(customUntil)}`
        : t("custom")
      : t(`presets.${preset}`)

  const choosePreset = (p: RangePreset) => {
    onPreset(p)
    setOpen(false)
  }

  const applyCustom = () => {
    const since = fromLocalInput(fromStr)
    const until = fromLocalInput(toStr)
    if (since === null || until === null) return
    onCustom(since, until)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" data-testid="time-range-trigger">
          <ClockIcon className="size-3.5" />
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
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            onClick={applyCustom}
            disabled={!fromStr || !toStr}
            data-testid="range-apply-custom"
          >
            {t("apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
