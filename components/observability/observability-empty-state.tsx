"use client"

/**
 * Full-dashboard empty state — shown when the selected time window holds no
 * spans at all (as opposed to filters hiding everything, which the per-panel
 * "no data" hints cover). Explains what produces telemetry and offers a
 * one-click widen to the longest preset.
 */

import { useTranslations } from "next-intl"
import { GaugeIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export interface ObservabilityEmptyStateProps {
  /** Widen the range to the longest preset. Absent → button hidden. */
  onWidenRange?: () => void
}

export function ObservabilityEmptyState({ onWidenRange }: ObservabilityEmptyStateProps) {
  const t = useTranslations("observability.empty")
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="observability-empty"
    >
      <div className="rounded-full border border-dashed p-4">
        <GaugeIcon className="size-8 text-muted-foreground/50" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <p className="max-w-sm text-xs text-muted-foreground">{t("hint")}</p>
      </div>
      {onWidenRange && (
        <Button variant="outline" size="sm" onClick={onWidenRange} data-testid="empty-widen">
          {t("widen")}
        </Button>
      )}
    </div>
  )
}
