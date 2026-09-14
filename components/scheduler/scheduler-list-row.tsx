"use client"

/**
 * One row in the scheduler list (ADR-0179 §4).
 *
 * The whole row is a button, like `/bots`: no hover "⋯" menu, no nested
 * controls, so the list stays usable with a keyboard and on touch. Actions
 * live in the detail, the keyboard and the bulk toolbar. The one thing that
 * stays interactive beside the button is the multi-select checkbox, which
 * sits outside it and reveals on hover or once anything is checked.
 *
 * The second line is the row's reason to exist: the item's attention signal
 * when it has one (failed last night, running now, cannot run here), else
 * the trigger and the next run. Kind is an icon; grouping by kind is gone.
 */

import { memo } from "react"
import { useTranslations } from "next-intl"

import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { formatNextRun } from "@/lib/scheduler/format-utils"
import type { AttentionSignal } from "@/lib/scheduler/attention"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

import {
  AuthoredByBadge,
  ItemStatusDot,
  KIND_PLATE,
  KindIcon,
  SEVERITY_TONE,
  useTriggerText,
} from "./kind-visuals"

export interface SchedulerListRowProps {
  item: UnifiedScheduledItem
  signal: AttentionSignal | null
  selected: boolean
  highlighted?: boolean
  checked: boolean
  onSelect: (item: UnifiedScheduledItem) => void
  onToggleCheck: (item: UnifiedScheduledItem) => void
  /** Whether any row is checked; keeps every checkbox visible during a bulk session. */
  checkMode?: boolean
}

/** The one line an attention signal shows on a row. */
export function useAttentionLine(): (signal: AttentionSignal) => string {
  const t = useTranslations("scheduler.attention")
  return (signal) => {
    switch (signal.kind) {
      case "auto-paused":
        return t("row.autoPaused", { count: signal.count ?? 0 })
      case "consecutive-failures":
        return t("row.consecutiveFailures", { count: signal.count ?? 0 })
      case "last-run-failed":
        return signal.detail
          ? t("row.lastRunFailedWith", { error: signal.detail })
          : t("row.lastRunFailed")
      case "unsupported-type":
        return t("row.unsupportedType")
      case "running":
        return signal.processCount
          ? t("row.runningWithProcesses", { count: signal.processCount })
          : t("row.running")
      // The page-level kinds never attach to an item row.
      case "source-failed":
      case "awaiting-confirmation":
      case "host-suspended":
      case "quota-near-limit":
        return ""
    }
  }
}

function SchedulerListRowImpl({
  item,
  signal,
  selected,
  highlighted,
  checked,
  onSelect,
  onToggleCheck,
  checkMode = false,
}: SchedulerListRowProps) {
  const t = useTranslations("scheduler")
  const triggerText = useTriggerText()
  const attentionLine = useAttentionLine()
  const nextRun = item.nextRunAt ? new Date(item.nextRunAt) : undefined

  return (
    <div
      className={cn(
        "group relative flex items-stretch",
        highlighted && "ring-1 ring-inset ring-primary/50 rounded-md"
      )}
      data-testid={`scheduler-list-row-${item.unifiedId}`}
      data-selected={selected || undefined}
    >
      <span
        className={cn(
          "flex w-7 shrink-0 items-center justify-center transition-opacity",
          checkMode || checked
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
        )}
      >
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggleCheck(item)}
          aria-label={t("selectRow")}
          className="size-3.5"
          data-testid="scheduler-list-row-check"
        />
      </span>
      <button
        type="button"
        onClick={() => onSelect(item)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-start gap-2.5 rounded-md py-2 pe-2.5 ps-1 text-left transition-colors",
          "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected && "bg-muted",
          checked && !selected && "bg-muted/40"
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md",
            KIND_PLATE[item.kind]
          )}
        >
          <KindIcon kind={item.kind} className="size-3 text-current" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <ItemStatusDot status={item.status} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
            <AuthoredByBadge source={item.createdBySource} />
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs">
            {signal ? (
              <span
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5",
                  SEVERITY_TONE[signal.severity].text
                )}
                data-testid="scheduler-list-row-signal"
                data-severity={signal.severity}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    SEVERITY_TONE[signal.severity].dot
                  )}
                />
                <span className="min-w-0 truncate">{attentionLine(signal)}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {triggerText(item.triggerSummary)}
              </span>
            )}
            <span
              className="shrink-0 tabular-nums text-muted-foreground/80"
              data-testid="scheduler-list-row-next"
            >
              {nextRun
                ? formatNextRun(nextRun, {
                    noSchedule: t("noSchedule"),
                    overdue: t("overdue"),
                    lessThanMinute: t("lessThanMinute"),
                  })
                : t("noSchedule")}
            </span>
          </span>
        </span>
      </button>
    </div>
  )
}

export const SchedulerListRow = memo(SchedulerListRowImpl)
