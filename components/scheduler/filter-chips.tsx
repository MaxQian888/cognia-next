"use client"

import { cn } from "@/lib/utils"

interface FilterChip {
  key: string
  label: string
  count?: number
}

interface FilterChipsProps {
  filters: FilterChip[]
  activeFilter: string
  onFilterChange: (key: string) => void
}

export function FilterChips({ filters, activeFilter, onFilterChange }: FilterChipsProps) {
  return (
    <div className="flex gap-1.5 overflow-x-auto px-3 pb-2 scrollbar-none">
      {filters.map((filter) => (
        <button
          key={filter.key}
          type="button"
          data-active={activeFilter === filter.key}
          onClick={() => onFilterChange(filter.key)}
          className={cn(
            "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
            activeFilter === filter.key
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
          )}
        >
          {filter.label}
          {filter.count !== undefined && (
            <span className="ml-1 tabular-nums text-[10px] opacity-70">{filter.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}
