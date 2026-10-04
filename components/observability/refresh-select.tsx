"use client"

/**
 * Auto-refresh cadence selector (off / 5s / 10s / 30s / 1m). The chosen value
 * drives `useRefreshTick`, which slides relative time windows and forces a
 * re-query even when the span table is idle.
 *
 * Cadence labels go through `useObservabilityFormatters().duration`, i.e.
 * next-intl's unit formatting in the APP locale — the old `${ms / 1000}s`
 * printed "5s" in the zh-CN UI too.
 */

import { useTranslations } from "next-intl"
import { RefreshCwIcon } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  useObservabilityFormatters,
  type ObservabilityFormatters,
} from "@/hooks/observability/use-observability-formatters"
import { REFRESH_OPTIONS, type RefreshMs } from "@/stores/observability/observability-store"

export interface RefreshSelectProps {
  value: RefreshMs
  onChange: (ms: RefreshMs) => void
  /** Drop the trigger to the width of its value — narrow toolbars only. */
  compact?: boolean
}

/** `0` is "Off"; every other cadence is a localized duration. Exported for tests. */
export function refreshLabel(
  ms: RefreshMs,
  t: (key: string) => string,
  fmt: Pick<ObservabilityFormatters, "duration">
): string {
  return ms === 0 ? t("off") : fmt.duration(ms)
}

export function RefreshSelect({ value, onChange, compact = false }: RefreshSelectProps) {
  const t = useTranslations("observability.refresh")
  const fmt = useObservabilityFormatters()
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v) as RefreshMs)}>
      <SelectTrigger
        size="sm"
        className={compact ? "w-[74px]" : "w-[112px]"}
        data-testid="refresh-select"
        aria-label={t("label")}
      >
        <RefreshCwIcon className="size-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {REFRESH_OPTIONS.map((ms) => (
            <SelectItem key={ms} value={String(ms)} data-testid={`refresh-option-${ms}`}>
              {refreshLabel(ms, t, fmt)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
