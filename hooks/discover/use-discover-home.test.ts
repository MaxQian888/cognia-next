/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

// Mock the per-category query so the home hook can be tested in isolation.
const queryData: Record<string, { items: DiscoverItem[]; loading: boolean }> = {}
jest.mock("@/hooks/discover/use-discover-query", () => ({
  useDiscoverQuery: (category: string) => queryData[category] ?? { items: [], loading: false },
}))

import { useDiscoverHome } from "./use-discover-home"

const character = (id: string, builtIn = false, updatedAt = 0): DiscoverItem => ({
  kind: "character",
  id,
  data: { id, name: id, isBuiltIn: builtIn, updatedAt } as never,
})
const workflowTemplate = (id: string): DiscoverItem => ({
  kind: "workflowTemplate",
  id,
  data: { id, label: { en: id, "zh-CN": id }, description: { en: "", "zh-CN": "" } } as never,
})

beforeEach(() => {
  for (const k of Object.keys(queryData)) delete queryData[k]
})

describe("useDiscoverHome", () => {
  it("builds non-empty sections with group + total", () => {
    queryData.characters = { items: [character("c1"), character("c2")], loading: false }
    queryData.workflowTemplates = { items: [workflowTemplate("w1")], loading: false }
    const { result } = renderHook(() => useDiscoverHome(""))
    const sections = result.current.sections
    const charSection = sections.find((s) => s.category === "characters")
    expect(charSection).toBeDefined()
    expect(charSection?.group).toBe("agents")
    expect(charSection?.total).toBe(2)
    // Empty categories produce no section.
    expect(sections.find((s) => s.category === "plugins")).toBeUndefined()
  })

  it("truncates a section row to the section limit but keeps the true total", () => {
    queryData.characters = {
      items: Array.from({ length: 20 }, (_, i) => character(`c${i}`)),
      loading: false,
    }
    const { result } = renderHook(() => useDiscoverHome(""))
    const section = result.current.sections.find((s) => s.category === "characters")
    expect(section?.total).toBe(20)
    expect(section?.items.length).toBeLessThanOrEqual(8)
  })

  it("features built-in items and workflow templates", () => {
    queryData.characters = {
      items: [character("c1", true), character("c2", false)],
      loading: false,
    }
    queryData.workflowTemplates = { items: [workflowTemplate("w1")], loading: false }
    const { result } = renderHook(() => useDiscoverHome(""))
    const featuredIds = result.current.featured.map((i) => i.id)
    expect(featuredIds).toContain("c1")
    expect(featuredIds).toContain("w1")
    expect(featuredIds).not.toContain("c2")
  })

  it("sorts recent by timestamp descending and drops timestamp-less items", () => {
    queryData.characters = {
      items: [
        character("old", false, 10),
        character("new", false, 99),
        character("none", false, 0),
      ],
      loading: false,
    }
    const { result } = renderHook(() => useDiscoverHome(""))
    expect(result.current.recent.map((i) => i.id)).toEqual(["new", "old"])
  })

  it("dedupes the flat items list across categories", () => {
    // The same plugin can appear in its own category and (later) favorites; the
    // flat list must not double-count a kind:id.
    queryData.characters = { items: [character("c1"), character("c1")], loading: false }
    const { result } = renderHook(() => useDiscoverHome(""))
    expect(result.current.items.filter((i) => i.id === "c1")).toHaveLength(1)
  })

  it("exposes searchResults only while searching", () => {
    queryData.characters = { items: [character("c1")], loading: false }
    const idle = renderHook(() => useDiscoverHome(""))
    expect(idle.result.current.searching).toBe(false)
    expect(idle.result.current.searchResults).toHaveLength(0)

    const searching = renderHook(() => useDiscoverHome("alpha"))
    expect(searching.result.current.searching).toBe(true)
    expect(searching.result.current.searchResults.map((i) => i.id)).toEqual(["c1"])
  })

  it("reports loading when a Dexie-backed category is still loading", () => {
    queryData.characters = { items: [], loading: true }
    const { result } = renderHook(() => useDiscoverHome(""))
    expect(result.current.loading).toBe(true)
  })
})
