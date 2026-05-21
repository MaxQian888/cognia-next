"use client"

// Shared toolbar for preset-management surfaces (system-prompt presets in
// `/settings/presets` and `/me/presets`). Provides search, a slot for
// caller-defined filter chips, a slot for right-aligned actions
// (reorder/new/import-export), and a fixed-bottom bulk-actions bar that
// appears when `selectionCount > 0`. The bulk bar borrows the structural
// idiom from `components/plugins/plugin-batch-actions-bar.tsx` so the two
// management surfaces feel like siblings.

import * as React from "react"
import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export interface PresetListToolbarProps {
  searchValue: string
  onSearchChange: (next: string) => void
  /** Slot for filter chips (Toggle/Badge/Button). Rendered below the search row. */
  filterChips?: React.ReactNode
  /** Right-aligned actions next to the search input (reorder, new, More-menu). */
  rightActions?: React.ReactNode
  /** Number of currently selected rows. When > 0, the fixed-bottom bulk bar shows. */
  selectionCount?: number
  onClearSelection?: () => void
  /** Buttons rendered inside the bulk bar (bulk favorite, bulk delete). */
  bulkActions?: React.ReactNode
  /** Override the default placeholder text. */
  searchPlaceholder?: string
  className?: string
  testId?: string
}

export function PresetListToolbar({
  searchValue,
  onSearchChange,
  filterChips,
  rightActions,
  selectionCount = 0,
  onClearSelection,
  bulkActions,
  searchPlaceholder,
  className,
  testId,
}: PresetListToolbarProps) {
  const t = useTranslations("presets.toolbar")
  // safeT mirrors the pattern in `prompt-presets-section.tsx` — when the
  // translation lookup echoes the key back (missing i18n entry or test
  // mock), fall back to the English literal so the UI never shows raw
  // dotted keys.
  const safeT = (k: string, fallback: string, vars?: Record<string, unknown>) => {
    const out = t(k as never, vars as never)
    return out === `presets.toolbar.${k}` || out === k ? fallback : out
  }
  const showBulk = selectionCount > 0

  return (
    <div className={cn("space-y-2", className)} data-testid={testId}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder ?? safeT("searchPlaceholder", "Search presets…")}
            className="pl-8"
            aria-label={safeT("searchAriaLabel", "Search presets")}
          />
        </div>
        {rightActions && (
          <div className="flex items-center gap-2" data-testid="preset-list-toolbar-right">
            {rightActions}
          </div>
        )}
      </div>

      {filterChips && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={safeT("filterGroupAriaLabel", "Filter presets")}
          data-testid="preset-list-toolbar-filters"
        >
          {filterChips}
        </div>
      )}

      {showBulk && (
        <Card
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-30 flex max-w-[min(calc(100vw-1rem),32rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 overflow-hidden px-4 py-2 shadow-lg"
          role="region"
          aria-label={safeT("bulkAriaLabel", "Bulk preset actions")}
          data-testid="preset-list-toolbar-bulk"
        >
          <Badge variant="secondary" className="text-xs">
            {safeT("selected", `${selectionCount} selected`, { count: selectionCount })}
          </Badge>
          {bulkActions && (
            <>
              <div className="mx-1 h-4 w-px bg-border" aria-hidden />
              {bulkActions}
            </>
          )}
          <div className="mx-1 h-4 w-px bg-border" aria-hidden />
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={onClearSelection}
            aria-label={safeT("clearSelection", "Clear selection")}
          >
            <XIcon className="size-3.5" />
          </Button>
        </Card>
      )}
    </div>
  )
}
