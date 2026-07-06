"use client"

/**
 * Shared item grid for the discover page — used by the desktop center pane
 * and the mobile body. Renders the items it's handed in one of three view
 * modes (grid / list / compact) and dispatches selection back to the URL state
 * hook via `onSelectItem`. It reads `useDiscoverFavorites` (settings store, not
 * Dexie) so every item card carries a working favorite star.
 */

import { useTranslations } from "next-intl"
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

const EMPTY_KEY_BY_CATEGORY: Partial<Record<DiscoverView, string>> = {
  characters: "emptyCharacters",
  teams: "emptyTeams",
  skills: "emptySkills",
  plugins: "emptyPlugins",
  mcpTools: "emptyMcpTools",
  connectors: "emptyConnectors",
  ocrProviders: "emptyOcrProviders",
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

  if (loading) {
    // Shimmer placeholders shaped like the active view (parity with the mobile
    // ListSkeleton) so the pane doesn't jump from a centred spinner to a grid.
    return (
      <div
        aria-busy="true"
        aria-label={t("grid.loading")}
        className={cn("overflow-y-auto p-4", DISCOVER_VIEW_CONTAINER[view], className)}
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

  return (
    <ul
      role="list"
      aria-label={t("grid.aria", { category: categoryLabel })}
      className={cn("overflow-y-auto p-4", DISCOVER_VIEW_CONTAINER[view], className)}
      data-testid={`discover-grid-${category}`}
    >
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className={view === "grid" ? "h-full" : undefined}>
          <DiscoverItemCard
            item={item}
            view={view}
            selected={item.id === selectedItemId}
            onSelect={() => onSelectItem(item.id)}
            favorited={isFavorite(item.kind, item.id)}
            onToggleFavorite={() => void toggleFavorite(item.kind, item.id)}
          />
        </li>
      ))}
    </ul>
  )
}
