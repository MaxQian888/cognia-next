"use client"

/**
 * Grafana-style template-variable bar: one multi-select per filterable
 * dimension (model / surface / operation / tool / provider / project /
 * session). Options are derived from the windowed spans so only values
 * actually present appear.
 *
 * Seven dropdowns is ~480px of toolbar, which is more than the `/logs` Traces
 * channel has to give on anything narrower than a maximised desktop window —
 * the row it lives in also carries the range picker, the refresh controls,
 * export and settings. `collapsed` folds the whole set behind one trigger
 * carrying the active count.
 *
 * Collapsed mode is a two-level **drill-down inside one popover**, not seven
 * popovers nested in an eighth: a non-modal Radix layer treats a pointer-down
 * inside a child popover (which portals to `body`, outside the parent's node)
 * as an outside press and dismisses the parent, so the nested version would
 * close itself on the first click. The option list is shared between both
 * modes, so the two layouts can never drift on what a filter row does.
 *
 * The caller decides collapsed/expanded from a measured container width, not a
 * viewport media query — the shell rail and the channel list eat several
 * hundred px the viewport knows nothing about.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ListFilterIcon, XIcon } from "lucide-react"
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

// Every dimension `applyFilters` understands. `provider` / `project` (the
// ADR-0130 cost-attribution axes) were filterable in `lib/observability/filters.ts`
// and plotted by the `bd-provider` / `bd-project` panels, but had no control
// here — so the only way to set them was to click a breakdown slice.
const DIMENSIONS: readonly Dimension[] = [
  "model",
  "surface",
  "operation",
  "tool",
  "provider",
  "project",
  "session",
]

/** How many individual values are selected across every dimension. */
export function activeFilterCount(filters: TraceFilters): number {
  return DIMENSIONS.reduce(
    (total, dim) => total + ((filters[dim] as string[] | undefined)?.length ?? 0),
    0
  )
}

export interface VariableFilterBarProps {
  windowSpans: AgentTraceSpan[]
  filters: TraceFilters
  onChange: (filters: TraceFilters) => void
  /** Fold the dimension dropdowns behind a single "Filters" trigger. */
  collapsed?: boolean
}

export function VariableFilterBar({
  windowSpans,
  filters,
  onChange,
  collapsed = false,
}: VariableFilterBarProps) {
  const t = useTranslations("observability.filters")

  const selectedFor = (dim: Dimension) => (filters[dim] as string[] | undefined) ?? []
  const toggle = (dim: Dimension, value: string) => onChange(toggleFilterValue(filters, dim, value))

  const clearButton = !isFilterEmpty(filters) ? (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 gap-1 px-2 text-xs text-muted-foreground",
        collapsed && "w-full justify-start"
      )}
      onClick={() => onChange({})}
      data-testid="filter-clear"
    >
      <XIcon className="size-3" />
      {t("clear")}
    </Button>
  ) : null

  if (collapsed) {
    return (
      <CollapsedFilters
        windowSpans={windowSpans}
        filters={filters}
        selectedFor={selectedFor}
        onToggle={toggle}
        clearButton={clearButton}
      />
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="variable-filter-bar">
      <ListFilterIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      {DIMENSIONS.map((dim) => (
        <Popover key={dim}>
          <PopoverTrigger asChild>
            <Button
              variant={selectedFor(dim).length > 0 ? "secondary" : "outline"}
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              data-testid={`filter-${dim}`}
            >
              {t(`dims.${dim}`)}
              {selectedFor(dim).length > 0 && (
                <Badge variant="default" className="h-4 min-w-4 px-1 text-[10px] tabular-nums">
                  {selectedFor(dim).length}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-0">
            <OptionList
              dim={dim}
              options={distinctValues(windowSpans, dim)}
              selected={selectedFor(dim)}
              searchPlaceholder={t("search")}
              emptyLabel={t("empty")}
              onToggle={(value) => toggle(dim, value)}
            />
          </PopoverContent>
        </Popover>
      ))}
      {clearButton}
    </div>
  )
}

interface CollapsedFiltersProps {
  windowSpans: AgentTraceSpan[]
  filters: TraceFilters
  selectedFor: (dim: Dimension) => string[]
  onToggle: (dim: Dimension, value: string) => void
  clearButton: React.ReactNode
}

function CollapsedFilters({
  windowSpans,
  filters,
  selectedFor,
  onToggle,
  clearButton,
}: CollapsedFiltersProps) {
  const t = useTranslations("observability.filters")
  const [open, setOpen] = useState(false)
  // `null` shows the dimension index; a dimension shows its option list.
  const [drill, setDrill] = useState<Dimension | null>(null)
  const count = activeFilterCount(filters)

  return (
    <div
      className="flex min-w-0 items-center"
      data-testid="variable-filter-bar"
      data-collapsed="true"
    >
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          // Reopening should start at the index, not wherever you left off.
          if (!next) setDrill(null)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant={count > 0 ? "secondary" : "outline"}
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            data-testid="filter-collapsed-trigger"
          >
            <ListFilterIcon className="size-3.5" aria-hidden="true" />
            {t("label")}
            {count > 0 && (
              <Badge variant="default" className="h-4 min-w-4 px-1 text-[10px] tabular-nums">
                {count}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-0">
          {drill === null ? (
            <>
              <ul className="p-1" data-testid="filter-dimension-index">
                {DIMENSIONS.map((dim) => (
                  <li key={dim}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-full justify-between gap-2 rounded-sm px-2 text-xs"
                      onClick={() => setDrill(dim)}
                      data-testid={`filter-${dim}`}
                    >
                      <span className="truncate">{t(`dims.${dim}`)}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {selectedFor(dim).length > 0 && (
                          <Badge
                            variant="default"
                            className="h-4 min-w-4 px-1 text-[10px] tabular-nums"
                          >
                            {selectedFor(dim).length}
                          </Badge>
                        )}
                        <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden />
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
              {clearButton && <div className="border-t p-1">{clearButton}</div>}
            </>
          ) : (
            <>
              <div className="flex items-center gap-1 border-b p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-1.5 text-xs"
                  onClick={() => setDrill(null)}
                  data-testid="filter-drill-back"
                >
                  <ChevronLeftIcon className="size-3.5" aria-hidden />
                  {t("back")}
                </Button>
                <span className="truncate text-xs font-medium">{t(`dims.${drill}`)}</span>
              </div>
              {/* Keyed on the dimension: every dimension gets a fresh
                  instance, so its search box starts empty. Unkeyed, one
                  instance served all seven from the same slot and carried its
                  `query` across a Back — drilling from Model (having typed
                  "sonnet") into Surface silently filtered surfaces by "sonnet"
                  and showed the empty state, reading as "this dimension has no
                  values". The expanded layout never had this because each
                  dimension owns its own popover. */}
              <OptionList
                key={drill}
                dim={drill}
                options={distinctValues(windowSpans, drill)}
                selected={selectedFor(drill)}
                searchPlaceholder={t("search")}
                emptyLabel={t("empty")}
                onToggle={(value) => onToggle(drill, value)}
              />
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

interface OptionListProps {
  dim: Dimension
  options: string[]
  selected: string[]
  searchPlaceholder: string
  emptyLabel: string
  onToggle: (value: string) => void
}

/** Search box + toggleable option rows. Shared by both layouts. */
function OptionList({
  dim,
  options,
  selected,
  searchPlaceholder,
  emptyLabel,
  onToggle,
}: OptionListProps) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(query.toLowerCase())),
    [options, query]
  )

  return (
    <>
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
    </>
  )
}
