"use client"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

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
    <ToggleGroup
      type="single"
      value={activeFilter}
      onValueChange={(value) => {
        if (value) onFilterChange(value)
      }}
      variant="outline"
      size="sm"
      spacing={1.5}
      className="flex w-full flex-wrap justify-start px-3 pb-2"
    >
      {filters.map((filter) => (
        <ToggleGroupItem
          key={filter.key}
          value={filter.key}
          data-active={activeFilter === filter.key}
          className="h-6 rounded-full px-2.5 text-[11px] data-[state=on]:border-primary/30 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
        >
          {filter.label}
          {filter.count !== undefined && (
            <span className="ml-1 tabular-nums text-[10px] opacity-70">{filter.count}</span>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
