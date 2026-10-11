/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import type { MemoryFacets } from "@/lib/memory/history-filter"
import { useMemoryFacetGroups } from "./memory-facet-groups"

const facets = {
  types: [{ value: "semantic", count: 2 }],
  scopes: [{ value: "workspace", count: 2 }],
  provenances: [],
  tags: Array.from({ length: 20 }, (_, i) => ({ value: `t${i}`, count: 1 })),
  projectMemoryKinds: [],
  projectIds: [
    { value: "p1", count: 1 },
    { value: "", count: 1 },
  ],
  branches: [],
  freshness: [],
} as unknown as MemoryFacets

describe("useMemoryFacetGroups", () => {
  it("lists every axis in a fixed order with translated labels", () => {
    const { result } = renderHook(() =>
      useMemoryFacetGroups({ facets, filter: {}, onFilterChange: jest.fn() })
    )
    expect(result.current.map((group) => group.key)).toEqual([
      "types",
      "scopes",
      "provenances",
      "tags",
      "projectMemoryKinds",
      "projectIds",
      "branches",
      "freshness",
    ])
    expect(result.current[0]!.label).toBe("Type")
  })

  it("caps the tag list and names workspaces, including no workspace", () => {
    const { result } = renderHook(() =>
      useMemoryFacetGroups({
        facets,
        filter: {},
        onFilterChange: jest.fn(),
        projectNames: { p1: "Cognia" },
      })
    )
    const tags = result.current.find((group) => group.key === "tags")!
    expect(tags.options).toHaveLength(12)
    const projects = result.current.find((group) => group.key === "projectIds")!
    expect(projects.render("p1")).toBe("Cognia")
    expect(projects.render("")).toBe("No workspace")
  })

  it("toggles a value without mutating the filter", () => {
    const onFilterChange = jest.fn()
    const filter = { scopes: ["workspace" as const] }
    const { result } = renderHook(() => useMemoryFacetGroups({ facets, filter, onFilterChange }))
    result.current.find((group) => group.key === "scopes")!.toggle("workspace")
    expect(onFilterChange).toHaveBeenCalledWith({ scopes: [] })
    expect(filter.scopes).toEqual(["workspace"])
  })
})
