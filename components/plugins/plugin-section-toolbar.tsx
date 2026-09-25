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
// Layout is a single row — search (flexes), segments, section tools. The
// row lives in `FeaturePageHeader`'s `controls` slot, which already
// scrolls horizontally when the pane is narrow. There is deliberately no
// status line beneath it: a second line whose height depends on filter
// state resizes the header band and shifts every pane under it — the
// defect `plugin-library-status-bar.tsx` was extracted to fix.
//
// `layout="stacked"` is the phone shape: the search takes its own line and
// segments + tools scroll on a second one. A mobile body has no header
// `controls` slot to scroll on its behalf, and at 375px the one-row form
// leaves the search input a few characters wide.

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
  /**
   * `"row"` (default) is the desktop shape: search, segments and tools share
   * one line, and the header's `controls` slot scrolls it horizontally when
   * the pane is narrow.
   *
   * `"stacked"` gives the search its own line and lets segments + tools scroll
   * on a second one. A phone has no `controls` slot to scroll for it, and at
   * 375px a single row leaves the search input a few characters wide.
   */
  layout?: "row" | "stacked"
  className?: string
  testId?: string
}

export function PluginSectionToolbar({
  search,
  segments,
  tools,
  layout = "row",
  className,
  testId = "plugin-section-toolbar",
}: PluginSectionToolbarProps) {
  const t = useTranslations("plugins.toolbar")
  const shownSegments = segments ? visibleSegments(segments.items, segments.value) : []
  const stacked = layout === "stacked"

  // `type="search"` gives a phone keyboard its Search key, lets Escape clear
  // the field, and opts the field into the coarse-pointer guard in
  // `app/globals.css` (16px text so iOS doesn't zoom on focus, 40px floor) —
  // a type-less input matched none of that guard's selectors. The engine's own
  // cancel glyph is hidden: it is unlabeled and ~14px, under the touch floor,
  // so the labeled button below replaces it and grows to 36px on touch.
  const searchNode = search ? (
    <div className={cn("relative min-w-0", stacked ? "w-full" : "flex-1")}>
      <SearchIcon
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={search.value}
        onChange={(e) => search.onChange(e.target.value)}
        placeholder={search.placeholder}
        aria-label={search.placeholder}
        className="h-8 pl-7 pr-8 text-sm pointer-coarse:pr-10 [&::-webkit-search-cancel-button]:hidden"
        data-testid={search.testId}
      />
      {search.value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => search.onChange("")}
          aria-label={t("clearSearch")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground pointer-coarse:right-0.5 pointer-coarse:size-9"
          data-testid={search.testId ? `${search.testId}-clear` : undefined}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  ) : null

  const segmentsNode =
    shownSegments.length > 0 && segments ? (
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
              <span className="ml-1.5 text-[10px] tabular-nums opacity-70">{segment.count}</span>
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    ) : null

  return (
    <div className={cn("w-full", className)} data-testid={testId} data-layout={layout}>
      {stacked ? (
        <div className="flex flex-col gap-2">
          {searchNode}
          {/* Segments and tools share one scroller so a phone can reach every
              control without the search input being squeezed to nothing. */}
          <div
            className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid={`${testId}-controls`}
          >
            {segmentsNode}
            {tools}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {searchNode}
          {segmentsNode}
          {tools}
        </div>
      )}
    </div>
  )
}
