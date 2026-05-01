/**
 * useAppGalleryFilter Hook
 * Encapsulates filter, sort, search, and view mode state for the AppGallery component
 */

import { useState, useMemo, useCallback } from "react"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"

export type ViewMode = "grid" | "list"
export type SortField = "name" | "lastModified" | "createdAt"
export type SortOrder = "asc" | "desc"

export const CATEGORY_KEYS = ["productivity", "data", "form", "utility", "social"] as const
export const CATEGORY_I18N_MAP: Record<string, string> = {
  productivity: "categoryProductivity",
  data: "categoryData",
  form: "categoryForm",
  utility: "categoryUtility",
  social: "categorySocial",
}

interface UseAppGalleryFilterOptions {
  defaultViewMode?: ViewMode
  getTemplate?: (
    templateId: string
  ) => { name: string; category: string; tags: string[] } | undefined
}

export function useAppGalleryFilter(
  allApps: A2UIAppInstance[],
  options: UseAppGalleryFilterOptions = {}
) {
  const { defaultViewMode = "grid", getTemplate } = options

  const [searchQuery, setSearchQuery] = useState("")
  const [viewMode, setViewMode] = useState<ViewMode>(defaultViewMode)
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [sortField, setSortField] = useState<SortField>("lastModified")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  const toggleSortOrder = useCallback(() => {
    setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))
  }, [])

  const filteredApps = useMemo(() => {
    let result = [...allApps]

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter((app) => {
        const template = getTemplate?.(app.templateId)
        return (
          app.name.toLowerCase().includes(query) ||
          app.description?.toLowerCase().includes(query) ||
          template?.name.toLowerCase().includes(query) ||
          template?.tags.some((t) => t.toLowerCase().includes(query)) ||
          app.tags?.some((t) => t.toLowerCase().includes(query))
        )
      })
    }

    // Category filter
    if (categoryFilter !== "all") {
      result = result.filter((app) => {
        const template = getTemplate?.(app.templateId)
        return app.category === categoryFilter || template?.category === categoryFilter
      })
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0
      switch (sortField) {
        case "name":
          comparison = a.name.localeCompare(b.name)
          break
        case "lastModified":
          comparison = a.lastModified - b.lastModified
          break
        case "createdAt":
          comparison = a.createdAt - b.createdAt
          break
      }
      return sortOrder === "asc" ? comparison : -comparison
    })

    return result
  }, [allApps, searchQuery, categoryFilter, sortField, sortOrder, getTemplate])

  return {
    // State
    searchQuery,
    viewMode,
    categoryFilter,
    sortField,
    sortOrder,
    filteredApps,
    // Setters
    setSearchQuery,
    setViewMode,
    setCategoryFilter,
    setSortField,
    setSortOrder,
    toggleSortOrder,
  }
}
