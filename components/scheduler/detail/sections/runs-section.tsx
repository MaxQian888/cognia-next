"use client"

/**
 * What this item has done (ADR-0179 §1): the one `RunRow` list, with a
 * Stop on every running row and a load-more when the page can fetch more.
 *
 * An OS task states that the platform keeps no run history, instead of an
 * empty list that reads as "never ran".
 */

import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import { RunRow } from "../../run-row"
import { listItemVariants, staticIf } from "../../scheduler-motion"

/** Placeholder rows while the first page of runs loads. */
const SKELETON_ROWS = 3

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
  const reduceMotion = useReducedMotion()
  const variants = staticIf(reduceMotion, listItemVariants)

  if (item.kind === "system") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="runs-section-no-history">
        {tDetail("noOsRunHistory")}
      </p>
    )
  }

  if (runs.length === 0) {
    if (loading) {
      return (
        <div
          className="flex flex-col gap-2 py-1"
          data-testid="runs-section-loading"
          aria-busy="true"
          aria-label={t("loading")}
        >
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </div>
      )
    }
    return (
      <p className="text-xs text-muted-foreground" data-testid="runs-section-empty">
        {t("noExecutionsYet")}
      </p>
    )
  }

  return (
    <div className="flex flex-col" data-testid="runs-section">
      {/* The rows already on screen stay still; a run that starts while the
          detail is open slides in at the top instead of appearing. */}
      <AnimatePresence initial={false}>
        {runs.map((run) => (
          <motion.div
            key={run.unifiedId}
            variants={variants}
            initial="hidden"
            animate="show"
            exit="exit"
          >
            <RunRow
              run={run}
              onOpen={onOpenRun}
              onCancel={onCancelRun}
              selected={selectedRunId === run.unifiedId}
            />
          </motion.div>
        ))}
      </AnimatePresence>
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
