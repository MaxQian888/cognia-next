"use client"

/**
 * URL-driven state for the discover page (`?category=&item=&sort=&filter=`).
 *
 * Centralises read + write of the search params so the desktop sidebar,
 * mobile chip strip, grid, and inspector all stay in sync via the URL
 * (rather than via a React context). Makes deep-links work: pasting
 * `/discover?category=plugins&item=foo&filter=installed` opens that plugin
 * directly with the installed-only filter applied.
 *
 * Static export note: any component that calls this hook must be wrapped in
 * `<Suspense>` because `useSearchParams()` opts out of static rendering
 * (Next.js 16 App Router requirement).
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { FORYOU_CATEGORY, isValidView, type DiscoverView } from "@/lib/discover/categories"

/** Sort modes exposed by the discover grid. */
export const DISCOVER_SORTS = ["name", "recent"] as const
export type DiscoverSort = (typeof DISCOVER_SORTS)[number]

/**
 * Filter chips. `installed` / `enabled` / `builtin` only apply to
 * categories that carry the corresponding concept (plugins / mcpTools /
 * connectors / skills); other categories ignore them gracefully. `favorites`
 * narrows any category to the user's starred items.
 */
export const DISCOVER_FILTERS = ["all", "installed", "enabled", "builtin", "favorites"] as const
export type DiscoverFilter = (typeof DISCOVER_FILTERS)[number]

export const DEFAULT_DISCOVER_SORT: DiscoverSort = "name"
export const DEFAULT_DISCOVER_FILTER: DiscoverFilter = "all"

function isValidSort(value: unknown): value is DiscoverSort {
  return typeof value === "string" && (DISCOVER_SORTS as readonly string[]).includes(value)
}

function isValidFilter(value: unknown): value is DiscoverFilter {
  return typeof value === "string" && (DISCOVER_FILTERS as readonly string[]).includes(value)
}

export interface DiscoverRouteState {
  category: DiscoverView
  /** Whether `?category=` was present and valid in the URL (vs. falling back to the default). */
  categoryExplicit: boolean
  item: string | null
  sort: DiscoverSort
  filter: DiscoverFilter
  /** Switches the active category (or the favorites pseudo-category). Always clears the selected item to avoid stale cross-category references. */
  setCategory: (id: DiscoverView) => void
  /**
   * Sets (or clears, via null) the selected item id within the current
   * category. Opening an item PUSHES a history entry (Back closes the detail,
   * Forward re-opens it); switching between items replaces it; closing pops
   * the entry this hook pushed, or replaces it when the item arrived by a cold
   * deep link.
   */
  setItem: (id: string | null) => void
  /** Convenience wrapper around setItem(null). */
  clearItem: () => void
  setSort: (value: DiscoverSort) => void
  setFilter: (value: DiscoverFilter) => void
}

export function useDiscoverRouteState(): DiscoverRouteState {
  const router = useRouter()
  const pathname = usePathname() ?? "/discover"
  const searchParams = useSearchParams()

  const category = useMemo<DiscoverView>(() => {
    const raw = searchParams?.get("category") ?? null
    // Absent / invalid `?category=` falls back to the aggregated "For You"
    // landing (the product default); the bodies then honour any saved
    // `landingCategory` preference via `resolveLandingCategory`.
    return isValidView(raw) ? raw : FORYOU_CATEGORY
  }, [searchParams])

  const categoryExplicit = useMemo<boolean>(
    () => isValidView(searchParams?.get("category") ?? null),
    [searchParams]
  )

  const item = useMemo<string | null>(() => {
    const raw = searchParams?.get("item")
    return raw && raw.length > 0 ? raw : null
  }, [searchParams])

  const sort = useMemo<DiscoverSort>(() => {
    const raw = searchParams?.get("sort") ?? null
    return isValidSort(raw) ? raw : DEFAULT_DISCOVER_SORT
  }, [searchParams])

  const filter = useMemo<DiscoverFilter>(() => {
    const raw = searchParams?.get("filter") ?? null
    return isValidFilter(raw) ? raw : DEFAULT_DISCOVER_FILTER
  }, [searchParams])

  const navigate = useCallback(
    (mode: "push" | "replace", mutator: (params: URLSearchParams) => void): void => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      mutator(next)
      const query = next.toString()
      const href = query ? `${pathname}?${query}` : pathname
      if (mode === "push") router.push(href, { scroll: false })
      else router.replace(href, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const replace = useCallback(
    (mutator: (params: URLSearchParams) => void): void => navigate("replace", mutator),
    [navigate]
  )

  // True while the history entry on top of the stack is the one this hook
  // pushed to open the current item. Closing then pops it with `router.back()`
  // so the sheet's close button and the browser's Back button do the same
  // thing, instead of close stacking a second "/discover" entry that Back
  // would have to walk through. A cold deep link (or a Forward into an item)
  // was not pushed by us, so closing it replaces the entry instead of leaving
  // the page.
  const pushedItemEntryRef = useRef(false)
  useEffect(() => {
    // Back/Forward or any external navigation that lands without an item
    // retires the pushed entry.
    if (item === null) pushedItemEntryRef.current = false
  }, [item])

  const setCategory = useCallback(
    (id: DiscoverView): void => {
      replace((params) => {
        params.set("category", id)
        // Selected item is scoped to a category. Switching categories must
        // clear the stale item id so the inspector does not try to look up
        // a character id in (say) the skills list.
        params.delete("item")
      })
    },
    [replace]
  )

  const setItem = useCallback(
    (id: string | null): void => {
      if (id && id.length > 0) {
        if (item === null) {
          // Opening a detail is a history step: Back closes it again and
          // Forward re-opens it.
          pushedItemEntryRef.current = true
          navigate("push", (params) => params.set("item", id))
        } else if (item !== id) {
          // Switching the open detail keeps ONE entry for "detail open", so a
          // single Back still returns to the catalog.
          navigate("replace", (params) => params.set("item", id))
        }
        return
      }
      if (item === null) return
      if (pushedItemEntryRef.current) {
        pushedItemEntryRef.current = false
        router.back()
        return
      }
      replace((params) => params.delete("item"))
    },
    [item, navigate, replace, router]
  )

  const clearItem = useCallback((): void => setItem(null), [setItem])

  const setSort = useCallback(
    (value: DiscoverSort): void => {
      replace((params) => {
        // Default value collapses to the implicit URL form so links stay short.
        if (value === DEFAULT_DISCOVER_SORT) params.delete("sort")
        else params.set("sort", value)
      })
    },
    [replace]
  )

  const setFilter = useCallback(
    (value: DiscoverFilter): void => {
      replace((params) => {
        if (value === DEFAULT_DISCOVER_FILTER) params.delete("filter")
        else params.set("filter", value)
      })
    },
    [replace]
  )

  return {
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
  }
}
