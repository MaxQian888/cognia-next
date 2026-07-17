"use client"

/**
 * "For You" aggregated landing for the discover page (`foryou` pseudo-category).
 *
 * Presentational: the body owns `useDiscoverHome(query)` and passes the result
 * down so the same `home.items` list also feeds the inspector. Reuses
 * `DiscoverItemCard` for the horizontal strips and `DiscoverGrid` for the flat
 * global-search results — no bespoke card/grid.
 */

import { useTranslations } from "next-intl"
import { ChevronRightIcon } from "lucide-react"

import { DiscoverGrid } from "@/components/discover/discover-grid"
import { DiscoverItemCard } from "@/components/discover/discover-item-card"
import { EmptyState } from "@/components/mobile/empty-state"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useDiscoverFavorites } from "@/hooks/discover/use-discover-favorites"
import type { DiscoverHomeResult, DiscoverHomeSection } from "@/hooks/discover/use-discover-home"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import { FORYOU_CATEGORY, type DiscoverView } from "@/lib/discover/categories"
import { cn } from "@/lib/utils"

export interface DiscoverHomeProps {
  home: DiscoverHomeResult
  query: string
  selectedItemId: string | null
  onSelectItem: (id: string) => void
  /** Jump to a full category (from a "View all" affordance). */
  onSelectCategory: (id: DiscoverView) => void
  className?: string
}

export function DiscoverHome({
  home,
  query,
  selectedItemId,
  onSelectItem,
  onSelectCategory,
  className,
}: DiscoverHomeProps) {
  const t = useTranslations("discover")

  // Global search: flatten every category's matches into one grid. Reuses the
  // shared grid (incl. its @container reflow + empty state).
  if (home.searching) {
    return (
      <div className={cn("h-full", className)} data-testid="discover-home-search">
        <DiscoverGrid
          category={FORYOU_CATEGORY}
          items={home.searchResults}
          loading={home.loading}
          query={query}
          view="grid"
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
        />
      </div>
    )
  }

  if (home.loading) {
    return (
      <div
        className={cn("flex flex-col gap-4 overflow-y-auto p-4", className)}
        data-testid="discover-home-loading"
        aria-busy="true"
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-5 w-32" />
            <div className="flex gap-3">
              {Array.from({ length: 3 }).map((_, j) => (
                <Skeleton key={j} className="h-24 w-56 shrink-0 rounded-md" />
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const hasContent = home.featured.length > 0 || home.recent.length > 0 || home.sections.length > 0

  if (!hasContent) {
    return (
      <div
        className={cn("flex flex-1 items-center justify-center p-6", className)}
        data-testid="discover-home-empty"
      >
        <EmptyState spotIcon="discover" title={t("home.empty")} description={t("home.emptyHint")} />
      </div>
    )
  }

  return (
    <div
      className={cn("flex flex-col gap-6 overflow-y-auto p-4", className)}
      data-testid="discover-home"
    >
      {home.featured.length > 0 ? (
        <HomeStrip
          title={t("home.featured")}
          items={home.featured}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
          testid="discover-home-featured"
        />
      ) : null}

      {home.recent.length > 0 ? (
        <HomeStrip
          title={t("home.recent")}
          items={home.recent}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
          testid="discover-home-recent"
        />
      ) : null}

      {home.sections.map((section) => (
        <HomeSectionRow
          key={section.category}
          section={section}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
          onSelectCategory={onSelectCategory}
        />
      ))}
    </div>
  )
}

function HomeSectionRow({
  section,
  selectedItemId,
  onSelectItem,
  onSelectCategory,
}: {
  section: DiscoverHomeSection
  selectedItemId: string | null
  onSelectItem: (id: string) => void
  onSelectCategory: (id: DiscoverView) => void
}) {
  const t = useTranslations("discover")
  return (
    <HomeStrip
      title={t(`categories.${section.category}`)}
      items={section.items}
      selectedItemId={selectedItemId}
      onSelectItem={onSelectItem}
      testid={`discover-home-section-${section.category}`}
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1 text-xs"
          onClick={() => onSelectCategory(section.category)}
          data-testid={`discover-home-viewall-${section.category}`}
        >
          {t("home.viewAll", { count: section.total })}
          <ChevronRightIcon className="size-3.5" />
        </Button>
      }
    />
  )
}

function HomeStrip({
  title,
  items,
  selectedItemId,
  onSelectItem,
  testid,
  action,
}: {
  title: string
  items: DiscoverItem[]
  selectedItemId: string | null
  onSelectItem: (id: string) => void
  testid: string
  action?: React.ReactNode
}) {
  const { isFavorite, toggleFavorite } = useDiscoverFavorites()
  return (
    <section className="flex flex-col gap-2" data-testid={testid}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <ul className="flex gap-3 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="w-56 shrink-0">
            <DiscoverItemCard
              item={item}
              view="grid"
              selected={item.id === selectedItemId}
              onSelect={() => onSelectItem(item.id)}
              favorited={isFavorite(item.kind, item.id)}
              onToggleFavorite={() => void toggleFavorite(item.kind, item.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
