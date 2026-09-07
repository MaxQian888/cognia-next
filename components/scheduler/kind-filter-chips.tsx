"use client"

/**
 * KindFilterChips: sidebar-side multi-select filter for kind (App / Workflow
 * / Backup / Plugin / System). Stacks above the existing status `FilterChips`.
 *
 * No "All" chip. This row sits directly under the status row, which has one of
 * its own, and on a phone the two rendered as the same word above the same
 * total: "All 4" twice, neither saying which axis it filtered. The reset it
 * offered is now a Clear chip that appears only once there is a selection to
 * clear, which is also the only moment it is actionable.
 */

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Toggle } from "@/components/ui/toggle"
import { SCHEDULED_ITEM_KINDS, type ScheduledItemKind } from "@/types/scheduler/unified"

export interface KindFilterChipsProps {
  selected: Set<ScheduledItemKind>
  onToggle: (kind: ScheduledItemKind) => void
  onClear: () => void
  countsByKind: Record<ScheduledItemKind, number>
}

export function KindFilterChips({
  selected,
  onToggle,
  onClear,
  countsByKind,
}: KindFilterChipsProps) {
  const t = useTranslations("scheduler")
  return (
    <div data-testid="kind-filter-chips" className="flex flex-wrap gap-1.5 px-3 pb-2">
      {selected.size > 0 ? (
        <Toggle
          variant="outline"
          size="sm"
          pressed={false}
          data-testid="kind-filter-clear"
          onPressedChange={onClear}
          className={cn(chipClass, inactiveClass)}
        >
          {t("kindFilter.clear")}
        </Toggle>
      ) : null}
      {SCHEDULED_ITEM_KINDS.map((kind) => {
        const isActive = selected.has(kind)
        const count = countsByKind[kind] ?? 0
        return (
          <Toggle
            key={kind}
            variant="outline"
            size="sm"
            pressed={isActive}
            data-active={isActive}
            data-testid={`kind-filter-${kind}`}
            onPressedChange={() => onToggle(kind)}
            className={cn(chipClass, isActive ? activeClass : inactiveClass)}
          >
            {t(`kindFilter.${kind}`) || labelFallback(kind)}
            <span className="ml-1 tabular-nums text-[10px] opacity-70">{count}</span>
          </Toggle>
        )
      })}
    </div>
  )
}

const chipClass =
  "shrink-0 rounded-pill border px-2.5 py-1 text-[11px] font-medium transition-colors"
const activeClass = "border-primary/30 bg-primary/10 text-primary"
const inactiveClass =
  "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"

function labelFallback(kind: ScheduledItemKind): string {
  switch (kind) {
    case "app":
      return "App"
    case "workflow":
      return "Workflow"
    case "backup":
      return "Backup"
    case "plugin":
      return "Plugin"
    case "system":
      return "System"
    case "connector":
      return "Connector"
  }
}
