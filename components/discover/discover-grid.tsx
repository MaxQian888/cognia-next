"use client"

/**
 * Shared item grid for the discover page — used by the desktop center pane
 * and the mobile body. Renders the items it's handed in one of three view
 * modes (grid / list / compact) and dispatches selection back to the URL state
 * hook via `onSelectItem`. It reads `useDiscoverFavorites` (settings store, not
 * Dexie) so every item card carries a working favorite star.
 */

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { useVirtualizer } from "@tanstack/react-virtual"
import { CompassIcon } from "lucide-react"

import { DiscoverItemCard } from "@/components/discover/discover-item-card"
import { EmptyState } from "@/components/mobile/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { useDiscoverFavorites } from "@/hooks/discover/use-discover-favorites"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import {
  DEFAULT_DISCOVER_VIEW,
  FAVORITES_CATEGORY,
  type DiscoverCategoryId,
  type DiscoverView,
  type DiscoverViewMode,
} from "@/lib/discover/categories"
import { DISCOVER_VIEW_CONTAINER } from "@/lib/discover/view-classes"
import { cn } from "@/lib/utils"

export interface DiscoverGridProps {
  category: DiscoverView
  items: DiscoverItem[]
  loading: boolean
  query: string
  selectedItemId: string | null
  onSelectItem: (id: string) => void
  /** Layout variant — defaults to the registry default ("grid"). */
  view?: DiscoverViewMode
  className?: string
}

/**
 * Above this item count, the single-column `list` / `compact` views switch to
 * windowed rendering (`useVirtualizer`, the repo standard — see
 * `components/workflow/library/workflow-library-list.tsx`). The multi-column
 * `grid` view stays non-virtualized: registries and most user libraries are
 * well below this, so windowing only kicks in for the rare long list.
 */
const VIRTUALIZE_THRESHOLD = 80

const EMPTY_KEY_BY_CATEGORY: Partial<Record<DiscoverView, string>> = {
  characters: "emptyCharacters",
  teams: "emptyTeams",
  skills: "emptySkills",
  teamTemplates: "emptyTeamTemplates",
  agentPresets: "emptyAgentPresets",
  plugins: "emptyPlugins",
  mcpTools: "emptyMcpTools",
  mcpPresets: "emptyMcpPresets",
  connectors: "emptyConnectors",
  ocrProviders: "emptyOcrProviders",
  slashCommands: "emptySlashCommands",
  workflowTemplates: "emptyWorkflowTemplates",
  twinIngest: "emptyTwinIngest",
  twinDrafts: "emptyTwinDrafts",
  [FAVORITES_CATEGORY]: "emptyFavorites",
}

export function DiscoverGrid({
  category,
  items,
  loading,
  query,
  selectedItemId,
  onSelectItem,
  view = DEFAULT_DISCOVER_VIEW,
  className,
}: DiscoverGridProps) {
  const t = useTranslations("discover")
  const trimmed = query.trim()
  const { isFavorite, toggleFavorite } = useDiscoverFavorites()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Windowing only applies to the single-column views (grid's variable column
  // count doesn't map onto a row virtualizer). The hook is called
  // unconditionally (React rules); `count: 0` makes it inert when not windowed.
  const windowed = (view === "list" || view === "compact") && items.length > VIRTUALIZE_THRESHOLD
  // TanStack Virtual's useVirtualizer returns non-memoizable functions; the
  // React Compiler correctly skips it. Nothing to fix on our side.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: windowed ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (view === "compact" ? 44 : 76),
    overscan: 8,
  })

  const renderCard = (item: DiscoverItem) => (
    <DiscoverItemCard
      item={item}
      view={view}
      selected={item.id === selectedItemId}
      onSelect={() => onSelectItem(item.id)}
      favorited={isFavorite(item.kind, item.id)}
      onToggleFavorite={() => void toggleFavorite(item.kind, item.id)}
    />
  )

  if (loading) {
    // Shimmer placeholders shaped like the active view (parity with the mobile
    // ListSkeleton) so the pane doesn't jump from a centred spinner to a grid.
    // The outer wrapper establishes the `@container/discover-grid` context that
    // the grid-mode column variants query (see view-classes.ts).
    return (
      <div className={cn("@container/discover-grid overflow-y-auto p-4", className)}>
        <div
          aria-busy="true"
          aria-label={t("grid.loading")}
          className={DISCOVER_VIEW_CONTAINER[view]}
          data-testid="discover-grid-loading"
        >
          {Array.from({ length: view === "compact" ? 8 : 6 }).map((_, i) => (
            <Skeleton
              key={i}
              className={cn(
                "w-full rounded-md",
                view === "grid" ? "h-28" : view === "compact" ? "h-10" : "h-16"
              )}
            />
          ))}
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    const emptyKey = EMPTY_KEY_BY_CATEGORY[category] ?? "empty.noQuery"
    return (
      <div
        className={cn("flex flex-1 items-center justify-center p-6", className)}
        data-testid="discover-grid-empty"
      >
        <EmptyState
          icon={CompassIcon}
          title={trimmed.length > 0 ? t("emptyFiltered", { query: trimmed }) : t(emptyKey)}
        />
      </div>
    )
  }

  const categoryLabel =
    category === FAVORITES_CATEGORY
      ? t("categories.favorites")
      : t(`categories.${category as DiscoverCategoryId}`)
  const ariaLabel = t("grid.aria", { category: categoryLabel })
  const gridTestId = `discover-grid-${category}`

  // Windowed path — long single-column lists. The `<ul>` becomes a positioned
  // spacer of the full virtual height; only the visible rows mount.
  if (windowed) {
    return (
      <div
        ref={scrollRef}
        className={cn("@container/discover-grid overflow-y-auto p-4", className)}
      >
        <ul
          role="list"
          aria-label={ariaLabel}
          data-testid={gridTestId}
          className="relative w-full"
          style={{ height: rowVirtualizer.getTotalSize() }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index]
            return (
              <li
                key={`${item.kind}-${item.id}`}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderCard(item)}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className={cn("@container/discover-grid overflow-y-auto p-4", className)}>
      <ul
        role="list"
        aria-label={ariaLabel}
        className={DISCOVER_VIEW_CONTAINER[view]}
        data-testid={gridTestId}
      >
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className={view === "grid" ? "h-full" : undefined}>
            {renderCard(item)}
          </li>
        ))}
      </ul>
    </div>
  )
}
