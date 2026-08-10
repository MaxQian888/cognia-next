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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export interface ObservabilityEmptyStateProps {
  /** Widen the range to the longest preset. Absent → button hidden. */
  onWidenRange?: () => void
}

export function ObservabilityEmptyState({ onWidenRange }: ObservabilityEmptyStateProps) {
  const t = useTranslations("observability.empty")
  return (
    <Empty
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="observability-empty"
    >
      <EmptyMedia variant="icon">
        <GaugeIcon className="size-8 text-muted-foreground/50" aria-hidden="true" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle className="text-sm">{t("title")}</EmptyTitle>
        <EmptyDescription className="max-w-sm text-xs">{t("hint")}</EmptyDescription>
      </EmptyHeader>
      {onWidenRange && (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onWidenRange} data-testid="empty-widen">
            {t("widen")}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}
