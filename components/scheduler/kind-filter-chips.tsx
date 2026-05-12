"use client"

/**
 * KindFilterChips — sidebar-side multi-select filter for kind (App / Workflow
 * / Backup / Plugin / System). Stacks above the existing status `FilterChips`.
 *
 * "all" is mutually exclusive with any specific selection: clicking "all"
 * clears the selection set; clicking a specific kind clears "all".
 */

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

export interface KindFilterChipsProps {
  selected: Set<ScheduledItemKind>
  onToggle: (kind: ScheduledItemKind) => void
  onClear: () => void
  countsByKind: Record<ScheduledItemKind, number>
}

const KIND_ORDER: ScheduledItemKind[] = [
  "app",
  "workflow",
  "backup",
  "plugin",
  "system",
  "connector",
]

export function KindFilterChips({
  selected,
  onToggle,
  onClear,
  countsByKind,
}: KindFilterChipsProps) {
  const t = useTranslations("scheduler")
  const allActive = selected.size === 0
  const totalCount = KIND_ORDER.reduce((sum, k) => sum + (countsByKind[k] ?? 0), 0)
  return (
    <div
      data-testid="kind-filter-chips"
      className="flex gap-1.5 overflow-x-auto px-3 pb-2 scrollbar-none"
    >
      <button
        type="button"
        data-active={allActive}
        onClick={onClear}
        className={cn(chipClass, allActive ? activeClass : inactiveClass)}
      >
        {t("kindFilter.all") || "All"}
        <span className="ml-1 tabular-nums text-[10px] opacity-70">{totalCount}</span>
      </button>
      {KIND_ORDER.map((kind) => {
        const isActive = selected.has(kind)
        const count = countsByKind[kind] ?? 0
        return (
          <button
            key={kind}
            type="button"
            data-active={isActive}
            data-testid={`kind-filter-${kind}`}
            onClick={() => onToggle(kind)}
            className={cn(chipClass, isActive ? activeClass : inactiveClass)}
          >
            {t(`kindFilter.${kind}`) || labelFallback(kind)}
            <span className="ml-1 tabular-nums text-[10px] opacity-70">{count}</span>
          </button>
        )
      })}
    </div>
  )
}

const chipClass =
  "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors"
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
