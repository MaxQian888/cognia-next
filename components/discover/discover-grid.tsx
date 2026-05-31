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
import { useDiscoverFavorites } from "@/hooks/discover/use-discover-favorites"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import {
  DEFAULT_DISCOVER_VIEW,
  FAVORITES_CATEGORY,
  type DiscoverCategoryId,
  type DiscoverView,
  type DiscoverViewMode,
} from "@/lib/discover/categories"
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

const CONTAINER_BY_VIEW: Record<DiscoverViewMode, string> = {
  grid: "grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  list: "flex flex-col gap-2 p-4",
  compact: "flex flex-col gap-1 p-4",
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
    return (
      <div
        aria-busy="true"
        className={cn("flex flex-1 items-center justify-center p-6", className)}
        data-testid="discover-grid-loading"
      >
        <span className="text-sm text-muted-foreground">{t("grid.loading")}</span>
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
      className={cn("overflow-y-auto", CONTAINER_BY_VIEW[view], className)}
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
