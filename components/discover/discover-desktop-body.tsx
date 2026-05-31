"use client"

/**
 * Desktop Discover body — wraps the shared sidebar / grid / inspector in
 * the canonical `FeaturePageShell` 3-pane layout. Tab state lives in the
 * URL via `useDiscoverRouteState` so `/discover?category=…&item=…` deep
 * links land directly on the right pane. The per-category view mode + the
 * category layout (default landing) come from settings (`useDiscoverView` /
 * `useDiscoverLayout`).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { DiscoverCategorySidebar } from "@/components/discover/discover-category-sidebar"
import { DiscoverGrid } from "@/components/discover/discover-grid"
import { DiscoverInspector } from "@/components/discover/discover-inspector"
import { DiscoverViewToggle } from "@/components/discover/discover-view-toggle"
import { SortFilterSheet } from "@/components/discover/sort-filter-sheet"
import { DiscoverSearch } from "@/components/mobile/discover/discover-search"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { useDiscoverLayout } from "@/hooks/discover/use-discover-layout"
import { useDiscoverFavorites } from "@/hooks/discover/use-discover-favorites"
import { useDiscoverQuery } from "@/hooks/discover/use-discover-query"
import { useDiscoverRouteState } from "@/hooks/discover/use-discover-route-state"
import { useDiscoverView } from "@/hooks/discover/use-discover-view"

export function DiscoverDesktopBody() {
  const t = useTranslations("discover")
  const {
    category,
    categoryExplicit,
    item,
    sort,
    filter,
    setCategory,
    setItem,
    clearItem,
    setSort,
    setFilter,
  } = useDiscoverRouteState()
  const [query, setQuery] = useState("")
  const { defaultCategory } = useDiscoverLayout()
  const { view } = useDiscoverView()
  const { favoriteKeys } = useDiscoverFavorites()
  const { items, loading } = useDiscoverQuery(category, query, { sort, filter, favoriteKeys })

  // When the URL carries no explicit category, land on the user's first
  // visible category (their layout default) rather than the registry default.
  useEffect(() => {
    if (!categoryExplicit && category !== defaultCategory) {
      setCategory(defaultCategory)
    }
  }, [categoryExplicit, category, defaultCategory, setCategory])

  return (
    <FeaturePageShell
      storageId="discover"
      toolbar={
        <div className="flex w-full items-center gap-3" data-testid="discover-desktop-toolbar">
          <h1 className="text-sm font-semibold">{t("title")}</h1>
          <div className="ml-auto flex items-center gap-2">
            <div className="w-72 max-w-full">
              <DiscoverSearch value={query} onChange={setQuery} />
            </div>
            <DiscoverViewToggle category={category} />
            <SortFilterSheet
              sort={sort}
              filter={filter}
              onSortChange={setSort}
              onFilterChange={setFilter}
            />
          </div>
        </div>
      }
      leftPane={{
        content: (
          <DiscoverCategorySidebar activeCategory={category} onSelect={(id) => setCategory(id)} />
        ),
        label: t("groups.aria"),
      }}
      rightPane={{
        content: (
          <DiscoverInspector category={category} itemId={item} items={items} onClose={clearItem} />
        ),
        label: t("inspector.aria"),
      }}
    >
      <DiscoverGrid
        category={category}
        items={items}
        loading={loading}
        query={query}
        view={view(category)}
        selectedItemId={item}
        onSelectItem={(id) => setItem(id)}
      />
    </FeaturePageShell>
  )
}
