"use client"

// The single implementation of the /plugins header's second tier.
//
// Before this component every section invented its own "switch the view
// inside this section" control: the left nav nested sub-items (Library
// status, Governance views), the Library header rendered counted chips,
// the marketplace rendered a horizontally-scrolling ToggleGroup, and the
// devtools panel rendered underlined Tabs. Four controls, one concept.
// Every section now feeds this one component instead, so the tier keeps a
// fixed position and a fixed control vocabulary and only its contents
// change as the user moves between sections.
//
// Layout is a single row — search (flexes), segments, section tools —
// with an optional status line beneath for active-filter chips and result
// counts. The row lives in `FeaturePageHeader`'s `controls` slot, which
// already scrolls horizontally when the pane is narrow.

import type { ReactNode } from "react"
import { SearchIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

export interface PluginToolbarSegment {
  value: string
  label: string
  /**
   * Row count behind the segment. Omit for segments that aren't countable
   * (Governance views, Devtools tool groups) — only numeric counts take
   * part in the zero-count rule below.
   */
  count?: number
}

/**
 * Drop segments whose count is exactly 0 — three of Library's five status
 * filters sit at 0 on a fresh install, and a filter that can only ever
 * produce an empty state is a dead end occupying the page's second-most
 * prominent tier.
 *
 * Two carve-outs keep the control honest:
 *   - the active segment always survives, so a count dropping to 0 while
 *     it is selected can't make the current selection disappear;
 *   - `count === undefined` means "not countable", not "zero".
 */
export function visibleSegments(
  items: readonly PluginToolbarSegment[],
  activeValue: string
): PluginToolbarSegment[] {
  return items.filter(
    (item) => item.count === undefined || item.count > 0 || item.value === activeValue
  )
}

export interface PluginSectionToolbarProps {
  search?: {
    value: string
    onChange: (value: string) => void
    /** Doubles as the input's aria-label — sections scope it themselves. */
    placeholder: string
    testId?: string
  }
  segments?: {
    ariaLabel: string
    items: readonly PluginToolbarSegment[]
    value: string
    onSelect: (value: string) => void
    testId?: string
  }
  /** Section-specific controls: sort, view toggle, filter sheet trigger. */
  tools?: ReactNode
  /** Second line — active-filter chips, result counts. Hidden when empty. */
  status?: ReactNode
  className?: string
  testId?: string
}

export function PluginSectionToolbar({
  search,
  segments,
  tools,
  status,
  className,
  testId = "plugin-section-toolbar",
}: PluginSectionToolbarProps) {
  const shownSegments = segments ? visibleSegments(segments.items, segments.value) : []

  return (
    <div className={cn("w-full space-y-2", className)} data-testid={testId}>
      <div className="flex items-center gap-2">
        {search && (
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder}
              aria-label={search.placeholder}
              className="h-8 pl-7 text-sm"
              data-testid={search.testId}
            />
          </div>
        )}

        {shownSegments.length > 0 && segments && (
          <ToggleGroup
            type="single"
            value={segments.value}
            onValueChange={(value) => {
              // Radix emits "" when the active item is re-clicked. A section
              // view is never "none", so swallow the deselect.
              if (value) segments.onSelect(value)
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label={segments.ariaLabel}
            className="shrink-0"
            data-testid={segments.testId}
          >
            {shownSegments.map((segment) => (
              <ToggleGroupItem
                key={segment.value}
                value={segment.value}
                className="h-8 px-2.5 text-xs data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
                data-testid={segments.testId ? `${segments.testId}-${segment.value}` : undefined}
              >
                {segment.label}
                {segment.count !== undefined && (
                  <span className="ml-1.5 text-[10px] tabular-nums opacity-70">
                    {segment.count}
                  </span>
                )}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}

        {tools}
      </div>

      {status}
    </div>
  )
}
