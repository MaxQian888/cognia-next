/**
 * Tests for useAppGalleryFilter — search/category/sort/view state combiner.
 */

import { renderHook, act } from "@testing-library/react"
import { useAppGalleryFilter, CATEGORY_KEYS, CATEGORY_I18N_MAP } from "./use-app-gallery-filter"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"

function makeApp(overrides: Partial<A2UIAppInstance>): A2UIAppInstance {
  return {
    id: overrides.id ?? "app-1",
    templateId: overrides.templateId ?? "todo-list",
    name: overrides.name ?? "App",
    createdAt: overrides.createdAt ?? 1_000,
    lastModified: overrides.lastModified ?? 1_000,
    ...overrides,
  }
}

const apps: A2UIAppInstance[] = [
  makeApp({
    id: "a",
    name: "Alpha Notes",
    templateId: "notes",
    createdAt: 100,
    lastModified: 300,
    description: "fast journaling",
    tags: ["focus"],
    category: "productivity",
  }),
  makeApp({
    id: "b",
    name: "Bravo Tracker",
    templateId: "habit-tracker",
    createdAt: 200,
    lastModified: 200,
    tags: ["habit"],
    category: "productivity",
  }),
  makeApp({
    id: "c",
    name: "Charlie Dashboard",
    templateId: "data-dashboard",
    createdAt: 50,
    lastModified: 500,
    category: "data",
  }),
]

const getTemplate = jest.fn((templateId: string) => {
  const map: Record<string, { name: string; category: string; tags: string[] }> = {
    notes: { name: "Notes", category: "productivity", tags: ["journal"] },
    "habit-tracker": { name: "Habits", category: "productivity", tags: ["health"] },
    "data-dashboard": { name: "Dashboard", category: "data", tags: ["charts"] },
  }
  return map[templateId]
})

describe("useAppGalleryFilter", () => {
  beforeEach(() => {
    getTemplate.mockClear()
  })

  it("exports the canonical category keys + i18n map", () => {
    expect(CATEGORY_KEYS).toEqual(["productivity", "data", "form", "utility", "social"])
    for (const key of CATEGORY_KEYS) {
      expect(CATEGORY_I18N_MAP[key]).toBeTruthy()
    }
  })

  it("defaults to lastModified-desc sort and grid view", () => {
    const { result } = renderHook(() => useAppGalleryFilter(apps, { getTemplate }))
    const ids = result.current.filteredApps.map((a) => a.id)
    expect(ids).toEqual(["c", "a", "b"]) // 500, 300, 200
    expect(result.current.viewMode).toBe("grid")
    expect(result.current.sortField).toBe("lastModified")
    expect(result.current.sortOrder).toBe("desc")
    expect(result.current.categoryFilter).toBe("all")
  })

  it("filters by search across name, description, app tags, and template tags", () => {
    const { result } = renderHook(() => useAppGalleryFilter(apps, { getTemplate }))

    act(() => result.current.setSearchQuery("alpha"))
    expect(result.current.filteredApps.map((a) => a.id)).toEqual(["a"])

    act(() => result.current.setSearchQuery("journal"))
    expect(result.current.filteredApps.map((a) => a.id)).toEqual(["a"]) // matches template tag

    act(() => result.current.setSearchQuery("dashboard"))
    expect(result.current.filteredApps.map((a) => a.id)).toEqual(["c"])

    act(() => result.current.setSearchQuery("nope"))
    expect(result.current.filteredApps).toEqual([])
  })

  it("filters by category (app- or template-level)", () => {
    const { result } = renderHook(() => useAppGalleryFilter(apps, { getTemplate }))

    act(() => result.current.setCategoryFilter("data"))
    expect(result.current.filteredApps.map((a) => a.id)).toEqual(["c"])

    act(() => result.current.setCategoryFilter("productivity"))
    expect(new Set(result.current.filteredApps.map((a) => a.id))).toEqual(new Set(["a", "b"]))

    act(() => result.current.setCategoryFilter("all"))
    expect(result.current.filteredApps).toHaveLength(3)
  })

  it("sorts by name (asc) and by createdAt", () => {
    const { result } = renderHook(() => useAppGalleryFilter(apps, { getTemplate }))

    act(() => {
      result.current.setSortField("name")
      result.current.setSortOrder("asc")
    })
    expect(result.current.filteredApps.map((a) => a.name)).toEqual([
      "Alpha Notes",
      "Bravo Tracker",
      "Charlie Dashboard",
    ])

    act(() => result.current.setSortField("createdAt"))
    expect(result.current.filteredApps.map((a) => a.id)).toEqual(["c", "a", "b"]) // 50, 100, 200 asc
  })

  it("toggleSortOrder flips between asc and desc", () => {
    const { result } = renderHook(() => useAppGalleryFilter(apps, { getTemplate }))
    expect(result.current.sortOrder).toBe("desc")
    act(() => result.current.toggleSortOrder())
    expect(result.current.sortOrder).toBe("asc")
    act(() => result.current.toggleSortOrder())
    expect(result.current.sortOrder).toBe("desc")
  })

  it("handles empty input array", () => {
    const { result } = renderHook(() => useAppGalleryFilter([], { getTemplate }))
    expect(result.current.filteredApps).toEqual([])
    act(() => result.current.setSearchQuery("anything"))
    expect(result.current.filteredApps).toEqual([])
  })

  it("respects defaultViewMode option", () => {
    const { result } = renderHook(() =>
      useAppGalleryFilter(apps, { defaultViewMode: "list", getTemplate })
    )
    expect(result.current.viewMode).toBe("list")
    act(() => result.current.setViewMode("grid"))
    expect(result.current.viewMode).toBe("grid")
  })
})
