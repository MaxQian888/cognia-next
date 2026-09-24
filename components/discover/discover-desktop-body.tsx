"use client"

/**
 * Desktop Discover body — wraps the shared sidebar / grid / overview rail in
 * the canonical `FeaturePageShell` 3-pane layout. Tab state lives in the
 * URL via `useDiscoverRouteState`, and `?item=` opens `DiscoverItemSheet`, so
 * `/discover?category=…&item=…` deep links land directly on the item's detail
 * on every window width. The detail used to live in the right rail only, which
 * below `lg` folds into an overlay Sheet this body never opened: a card click
 * updated the URL and nothing appeared. The rail now carries the category
 * overview and its marketplace CTAs. The per-category view mode, the category
 * layout, and the default landing category all come from settings
 * (`useDiscoverView` / `useDiscoverLayout` / `useDiscoverPreferences`).
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CompassIcon } from "lucide-react"

import { ActiveFilterChips } from "@/components/discover/active-filter-chips"
import { DiscoverCategorySidebar } from "@/components/discover/discover-category-sidebar"
import { DiscoverGrid } from "@/components/discover/discover-grid"
import { DiscoverHome } from "@/components/discover/discover-home"
import { DiscoverInspector } from "@/components/discover/discover-inspector"
import { DiscoverItemSheet } from "@/components/discover/discover-item-sheet"
import { DiscoverViewToggle } from "@/components/discover/discover-view-toggle"
import { SortFilterSheet } from "@/components/discover/sort-filter-sheet"
import { DiscoverSearch } from "@/components/mobile/discover/discover-search"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { useDiscoverHome } from "@/hooks/discover/use-discover-home"
import { useDiscoverLayout } from "@/hooks/discover/use-discover-layout"
import { useDiscoverFavorites } from "@/hooks/discover/use-discover-favorites"
import { useDiscoverPreferences } from "@/hooks/discover/use-discover-preferences"
import { useDiscoverQuery } from "@/hooks/discover/use-discover-query"
import { useDiscoverRouteState } from "@/hooks/discover/use-discover-route-state"
import { useDiscoverView } from "@/hooks/discover/use-discover-view"
import { useSearchHotkey } from "@/hooks/discover/use-search-hotkey"
import { FORYOU_CATEGORY, resolveLandingCategory } from "@/lib/discover/categories"

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
  const home = useDiscoverHome(query)
  const isHome = category === FORYOU_CATEGORY
  // On the aggregated landing the inspector reads the home hook's flat list; a
  // real category reads its own query result.
  const inspectorItems = isHome ? home.items : items
  const inspectorLoading = isHome ? home.loading : loading

  // Press "/" anywhere on the page to jump to the search box.
  useSearchHotkey(searchRef)

  // When the URL carries no explicit category, land on the user's preferred
  // category (Settings → Discover), falling back to their first visible one.
  // Not while an item is open: switching category clears `?item=`, so a cold
  // `/discover?item=char_…` link would otherwise be wiped before its sheet
  // could open. The redirect runs once the sheet is closed.
  const landing = useMemo(
    () => resolveLandingCategory(preferences.landingCategory, layout),
    [preferences.landingCategory, layout]
  )
  useEffect(() => {
    if (!categoryExplicit && item === null && category !== landing) {
      setCategory(landing)
    }
  }, [categoryExplicit, item, category, landing, setCategory])

  return (
    <FeaturePageShell
      storageId="discover"
      header={
        <FeaturePageHeader
          icon={<CompassIcon />}
          title={t("title")}
          summary={
            !isHome && !loading ? (
              <span data-testid="discover-result-count">
                {t("resultCount", { count: items.length })}
              </span>
            ) : undefined
          }
          controls={
            <div
              className="flex min-w-max items-center gap-2"
              data-testid="discover-desktop-toolbar"
            >
              {!isHome ? (
                <ActiveFilterChips
                  sort={sort}
                  filter={filter}
                  onSortChange={setSort}
                  onFilterChange={setFilter}
                />
              ) : null}
              <div className="ml-auto w-72 max-w-[60vw]">
                <DiscoverSearch value={query} onChange={setQuery} inputRef={searchRef} />
              </div>
              {!isHome ? <DiscoverViewToggle category={category} /> : null}
              {!isHome ? (
                <SortFilterSheet
                  sort={sort}
                  filter={filter}
                  onSortChange={setSort}
                  onFilterChange={setFilter}
                />
              ) : null}
            </div>
          }
        />
      }
      leftPane={{
        content: (
          <DiscoverCategorySidebar activeCategory={category} onSelect={(id) => setCategory(id)} />
        ),
        label: t("groups.aria"),
      }}
      rightPane={{
        // Overview only: the selected item opens in `DiscoverItemSheet` below.
        content: (
          <DiscoverInspector
            category={category}
            itemId={null}
            items={inspectorItems}
            onClose={clearItem}
          />
        ),
        label: t("inspector.aria"),
      }}
    >
      <DiscoverItemSheet
        itemId={item}
        items={inspectorItems}
        loading={inspectorLoading}
        category={category}
        onClose={clearItem}
      />
      {isHome ? (
        <DiscoverHome
          home={home}
          query={query}
          selectedItemId={item}
          onSelectItem={(id) => setItem(id)}
          onSelectCategory={(id) => setCategory(id)}
        />
      ) : (
        <DiscoverGrid
          category={category}
          items={items}
          loading={loading}
          query={query}
          view={view(category)}
          selectedItemId={item}
          onSelectItem={(id) => setItem(id)}
        />
      )}
    </FeaturePageShell>
  )
}
