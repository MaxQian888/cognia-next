"use client"

/**
 * One line per kind (ADR-0179 §3): the only place kind totals appear
 * outside the filter menu. Each line pins that kind in the list filter, so
 * the number a reader sees is the number of rows the list will show.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import type { UnifiedStatistics } from "@/lib/scheduler/unified-filter"
import { SCHEDULED_ITEM_KINDS, type ScheduledItemKind } from "@/types/scheduler/unified"

import { KIND_PLATE, KindIcon } from "../kind-visuals"

export interface KindSummaryProps {
  statistics: UnifiedStatistics
  selectedKinds: ReadonlySet<ScheduledItemKind>
  onToggleKind: (kind: ScheduledItemKind) => void
  className?: string
}

export function KindSummary({
  statistics,
  selectedKinds,
  onToggleKind,
  className,
}: KindSummaryProps) {
  const t = useTranslations("scheduler")
  const kinds = SCHEDULED_ITEM_KINDS.filter((kind) => statistics.countsByKind[kind] > 0)

  if (kinds.length === 0) {
    return (
      <p
        className={cn("text-xs text-muted-foreground", className)}
        data-testid="kind-summary-empty"
      >
        {t("noTasks")}
      </p>
    )
  }

  return (
    <ul className={cn("flex flex-col gap-0.5", className)} data-testid="kind-summary">
      {kinds.map((kind) => {
        const pinned = selectedKinds.has(kind)
        return (
          <li key={kind}>
            <button
              type="button"
              onClick={() => onToggleKind(kind)}
              aria-pressed={pinned}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                pinned && "bg-muted"
              )}
              data-testid={`kind-summary-${kind}`}
            >
              <span
                className={cn("flex size-5 items-center justify-center rounded", KIND_PLATE[kind])}
              >
                <KindIcon kind={kind} className="size-3 text-current" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t(`kindFilter.${kind}`)}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {t("kindSummary.activeOfTotal", {
                  active: statistics.activeCountsByKind[kind],
                  total: statistics.countsByKind[kind],
                })}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
