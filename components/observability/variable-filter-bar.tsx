"use client"

/**
 * Grafana-style template-variable bar: one multi-select per filterable
 * dimension (model / surface / operation / tool / session). Options are
 * derived from the windowed spans so only values actually present appear.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, ListFilterIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { distinctValues, type Dimension } from "@/lib/observability/breakdown"
import { isFilterEmpty, toggleFilterValue, type TraceFilters } from "@/lib/observability/filters"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

// Re-exported for backward compatibility — the pure toggle now lives in
// `lib/observability/filters.ts` so the click-to-filter breakdown panels can
// share it without importing from a component.
export { toggleFilterValue }

const DIMENSIONS: readonly Dimension[] = ["model", "surface", "operation", "tool", "session"]

export interface VariableFilterBarProps {
  windowSpans: AgentTraceSpan[]
  filters: TraceFilters
  onChange: (filters: TraceFilters) => void
}

export function VariableFilterBar({ windowSpans, filters, onChange }: VariableFilterBarProps) {
  const t = useTranslations("observability.filters")
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="variable-filter-bar">
      <ListFilterIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      {DIMENSIONS.map((dim) => (
        <FilterDropdown
          key={dim}
          dim={dim}
          label={t(`dims.${dim}`)}
          options={distinctValues(windowSpans, dim)}
          selected={(filters[dim] as string[] | undefined) ?? []}
          searchPlaceholder={t("search")}
          emptyLabel={t("empty")}
          onToggle={(value) => onChange(toggleFilterValue(filters, dim, value))}
        />
      ))}
      {!isFilterEmpty(filters) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => onChange({})}
          data-testid="filter-clear"
        >
          <XIcon className="size-3" />
          {t("clear")}
        </Button>
      )}
    </div>
  )
}

interface FilterDropdownProps {
  dim: Dimension
  label: string
  options: string[]
  selected: string[]
  searchPlaceholder: string
  emptyLabel: string
  onToggle: (value: string) => void
}

function FilterDropdown({
  dim,
  label,
  options,
  selected,
  searchPlaceholder,
  emptyLabel,
  onToggle,
}: FilterDropdownProps) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(query.toLowerCase())),
    [options, query]
  )

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={selected.length > 0 ? "secondary" : "outline"}
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          data-testid={`filter-${dim}`}
        >
          {label}
          {selected.length > 0 && (
            <Badge variant="default" className="h-4 min-w-4 px-1 text-[10px] tabular-nums">
              {selected.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="border-b p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-7 text-xs"
            data-testid={`filter-search-${dim}`}
          />
        </div>
        <ScrollArea className="max-h-56">
          <ul className="p-1">
            {filtered.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyLabel}</li>
            )}
            {filtered.map((opt) => {
              const isSelected = selected.includes(opt)
              return (
                <li key={opt}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onToggle(opt)}
                    className={cn(
                      "h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs whitespace-normal",
                      isSelected && "font-medium"
                    )}
                    data-testid={`filter-${dim}-option-${opt}`}
                    aria-pressed={isSelected}
                  >
                    <CheckIcon
                      className={cn("size-3.5 shrink-0", isSelected ? "opacity-100" : "opacity-0")}
                    />
                    <span className="truncate">{opt}</span>
                  </Button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
