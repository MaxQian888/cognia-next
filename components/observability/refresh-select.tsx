"use client"

/**
 * Auto-refresh cadence selector (off / 5s / 10s / 30s / 1m). The chosen value
 * drives `useRefreshTick`, which slides relative time windows and forces a
 * re-query even when the span table is idle.
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
import { REFRESH_OPTIONS, type RefreshMs } from "@/stores/observability/observability-store"

export interface RefreshSelectProps {
  value: RefreshMs
  onChange: (ms: RefreshMs) => void
  /** Drop the trigger to the width of its value — narrow toolbars only. */
  compact?: boolean
}

function labelFor(ms: RefreshMs, t: (key: string) => string): string {
  if (ms === 0) return t("off")
  if (ms < 60_000) return `${ms / 1000}s`
  return `${ms / 60_000}m`
}

export function RefreshSelect({ value, onChange, compact = false }: RefreshSelectProps) {
  const t = useTranslations("observability.refresh")
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
              {labelFor(ms, t)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
