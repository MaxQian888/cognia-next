"use client"

/**
 * What this item has done (ADR-0179 §1): the one `RunRow` list, with a
 * Stop on every running row and a load-more when the page can fetch more.
 *
 * An OS task states that the platform keeps no run history, instead of an
 * empty list that reads as "never ran".
 */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import { RunRow } from "../../run-row"

export interface RunsSectionProps {
  item: UnifiedScheduledItem
  runs: readonly UnifiedExecutionRun[]
  selectedRunId?: string | null
  onOpenRun: (run: UnifiedExecutionRun) => void
  onCancelRun?: (run: UnifiedExecutionRun) => void
  hasMore?: boolean
  onLoadMore?: () => void
  loading?: boolean
}

export function RunsSection({
  item,
  runs,
  selectedRunId,
  onOpenRun,
  onCancelRun,
  hasMore = false,
  onLoadMore,
  loading = false,
}: RunsSectionProps) {
  const t = useTranslations("scheduler")
  const tDetail = useTranslations("scheduler.detail")

  if (item.kind === "system") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="runs-section-no-history">
        {tDetail("noOsRunHistory")}
      </p>
    )
  }

  if (runs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="runs-section-empty">
        {loading ? t("loading") : t("noExecutionsYet")}
      </p>
    )
  }

  return (
    <div className="flex flex-col" data-testid="runs-section">
      {runs.map((run) => (
        <RunRow
          key={run.unifiedId}
          run={run}
          onOpen={onOpenRun}
          onCancel={onCancelRun}
          selected={selectedRunId === run.unifiedId}
        />
      ))}
      {hasMore && onLoadMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 h-7 self-start text-xs"
          onClick={onLoadMore}
          disabled={loading}
          data-testid="runs-section-load-more"
        >
          {t("loadMore")}
        </Button>
      ) : null}
    </div>
  )
}
