"use client"

/**
 * Desktop Discover body — wraps the shared sidebar / grid / inspector in
 * the canonical `FeaturePageShell` 3-pane layout. Tab state lives in the
 * URL via `useDiscoverRouteState` so `/discover?category=…&item=…` deep
 * links land directly on the right pane.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { DiscoverCategorySidebar } from "@/components/discover/discover-category-sidebar"
import { DiscoverGrid } from "@/components/discover/discover-grid"
import { DiscoverInspector } from "@/components/discover/discover-inspector"
import { SortFilterSheet } from "@/components/discover/sort-filter-sheet"
import { DiscoverSearch } from "@/components/mobile/discover/discover-search"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { useDiscoverQuery } from "@/hooks/discover/use-discover-query"
import { useDiscoverRouteState } from "@/hooks/discover/use-discover-route-state"

export function DiscoverDesktopBody() {
  const t = useTranslations("discover")
  const { category, item, sort, filter, setCategory, setItem, clearItem, setSort, setFilter } =
    useDiscoverRouteState()
  const [query, setQuery] = useState("")
  const { items, loading } = useDiscoverQuery(category, query, { sort, filter })

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
        selectedItemId={item}
        onSelectItem={(id) => setItem(id)}
      />
    </FeaturePageShell>
  )
}
