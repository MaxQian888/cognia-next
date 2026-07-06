"use client"

/**
 * Desktop Discover body — wraps the shared sidebar / grid / inspector in
 * the canonical `FeaturePageShell` 3-pane layout. Tab state lives in the
 * URL via `useDiscoverRouteState` so `/discover?category=…&item=…` deep
 * links land directly on the right pane. The per-category view mode, the
 * category layout, and the default landing category all come from settings
 * (`useDiscoverView` / `useDiscoverLayout` / `useDiscoverPreferences`).
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { ActiveFilterChips } from "@/components/discover/active-filter-chips"
import { DiscoverCategorySidebar } from "@/components/discover/discover-category-sidebar"
import { DiscoverGrid } from "@/components/discover/discover-grid"
import { DiscoverInspector } from "@/components/discover/discover-inspector"
import { DiscoverViewToggle } from "@/components/discover/discover-view-toggle"
import { SortFilterSheet } from "@/components/discover/sort-filter-sheet"
import { DiscoverSearch } from "@/components/mobile/discover/discover-search"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { useDiscoverLayout } from "@/hooks/discover/use-discover-layout"
import { useDiscoverFavorites } from "@/hooks/discover/use-discover-favorites"
import { useDiscoverPreferences } from "@/hooks/discover/use-discover-preferences"
import { useDiscoverQuery } from "@/hooks/discover/use-discover-query"
import { useDiscoverRouteState } from "@/hooks/discover/use-discover-route-state"
import { useDiscoverView } from "@/hooks/discover/use-discover-view"
import { useSearchHotkey } from "@/hooks/discover/use-search-hotkey"
import { resolveLandingCategory } from "@/lib/discover/categories"

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
  const searchRef = useRef<HTMLInputElement>(null)
  const { layout } = useDiscoverLayout()
  const { preferences } = useDiscoverPreferences()
  const { view } = useDiscoverView()
  const { favoriteKeys } = useDiscoverFavorites()
  const { items, loading } = useDiscoverQuery(category, query, { sort, filter, favoriteKeys })

  // Press "/" anywhere on the page to jump to the search box.
  useSearchHotkey(searchRef)

  // When the URL carries no explicit category, land on the user's preferred
  // category (Settings → Discover), falling back to their first visible one.
  const landing = useMemo(
    () => resolveLandingCategory(preferences.landingCategory, layout),
    [preferences.landingCategory, layout]
  )
  useEffect(() => {
    if (!categoryExplicit && category !== landing) {
      setCategory(landing)
    }
  }, [categoryExplicit, category, landing, setCategory])

  return (
    <FeaturePageShell
      storageId="discover"
      toolbar={
        <div className="flex w-full items-center gap-3" data-testid="discover-desktop-toolbar">
          <h1 className="text-sm font-semibold">{t("title")}</h1>
          {!loading ? (
            <span className="text-xs text-muted-foreground" data-testid="discover-result-count">
              {t("resultCount", { count: items.length })}
            </span>
          ) : null}
          <ActiveFilterChips
            sort={sort}
            filter={filter}
            onSortChange={setSort}
            onFilterChange={setFilter}
            className="hidden md:flex"
          />
          <div className="ml-auto flex items-center gap-2">
            <div className="w-72 max-w-full">
              <DiscoverSearch value={query} onChange={setQuery} inputRef={searchRef} />
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
