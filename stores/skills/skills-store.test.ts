import { act, renderHook } from "@testing-library/react"
import { useSkillsStore, type ImportStaging, type SkillFilters } from "./skills-store"
import * as barrel from "./"

it("barrel re-exports useSkillsStore", () => {
  expect(barrel.useSkillsStore).toBe(useSkillsStore)
})

const DEFAULT_FILTERS: SkillFilters = {
  query: "",
  category: "all",
  source: "all",
  status: "all",
  tag: null,
  sort: "name",
}

const RESET = {
  activeTab: "my-skills" as const,
  filters: DEFAULT_FILTERS,
  selection: new Set<string>(),
  detailSkillId: null,
  filterSheetOpen: false,
  editorTarget: null,
  importStaging: null,
  deleteTarget: null,
}

describe("useSkillsStore", () => {
  beforeEach(() => {
    useSkillsStore.setState(RESET)
  })

  it("starts with documented defaults", () => {
    const { result } = renderHook(() => useSkillsStore())
    expect(result.current.activeTab).toBe("my-skills")
    expect(result.current.filters).toEqual(DEFAULT_FILTERS)
    expect(result.current.selection.size).toBe(0)
    expect(result.current.detailSkillId).toBeNull()
    expect(result.current.filterSheetOpen).toBe(false)
    expect(result.current.editorTarget).toBeNull()
    expect(result.current.importStaging).toBeNull()
    expect(result.current.deleteTarget).toBeNull()
  })

  describe("tabs and filters", () => {
    it("setActiveTab switches tabs", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setActiveTab("browse"))
      expect(result.current.activeTab).toBe("browse")
      act(() => result.current.setActiveTab("editor"))
      expect(result.current.activeTab).toBe("editor")
      act(() => result.current.setActiveTab("analytics"))
      expect(result.current.activeTab).toBe("analytics")
    })

    it("setFilters does a partial merge", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setFilters({ query: "hello", sort: "updated" }))
      expect(result.current.filters).toEqual({
        ...DEFAULT_FILTERS,
        query: "hello",
        sort: "updated",
      })
    })

    it("setQuery only changes the query", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setFilters({ category: "code", sort: "usage" }))
      act(() => result.current.setQuery("yaml"))
      expect(result.current.filters.query).toBe("yaml")
      expect(result.current.filters.category).toBe("code")
      expect(result.current.filters.sort).toBe("usage")
    })

    it("resetFilters returns to the documented defaults", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setFilters({ query: "x", category: "code", sort: "usage" }))
      act(() => result.current.resetFilters())
      expect(result.current.filters).toEqual(DEFAULT_FILTERS)
    })
  })

  describe("selection", () => {
    it("toggleSelection adds and removes the id", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.toggleSelection("a"))
      expect([...result.current.selection]).toEqual(["a"])
      act(() => result.current.toggleSelection("b"))
      expect([...result.current.selection].sort()).toEqual(["a", "b"])
      act(() => result.current.toggleSelection("a"))
      expect([...result.current.selection]).toEqual(["b"])
    })

    it("selectAll replaces the selection", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.toggleSelection("z"))
      act(() => result.current.selectAll(["a", "b", "c"]))
      expect([...result.current.selection].sort()).toEqual(["a", "b", "c"])
    })

    it("clearSelection empties the selection", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.selectAll(["a", "b"]))
      act(() => result.current.clearSelection())
      expect(result.current.selection.size).toBe(0)
    })
  })

  describe("detail panel", () => {
    it("openDetail sets the id and closeDetail clears it", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openDetail("skill-1"))
      expect(result.current.detailSkillId).toBe("skill-1")
      act(() => result.current.closeDetail())
      expect(result.current.detailSkillId).toBeNull()
    })
  })

  describe("filter sheet", () => {
    it("setFilterSheetOpen toggles the panel", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setFilterSheetOpen(true))
      expect(result.current.filterSheetOpen).toBe(true)
      act(() => result.current.setFilterSheetOpen(false))
      expect(result.current.filterSheetOpen).toBe(false)
    })
  })

  describe("editor flow", () => {
    it("openCreate sets editor target to create and clears any open detail", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openDetail("hide-me"))
      act(() => result.current.openCreate())
      expect(result.current.editorTarget).toEqual({ mode: "create" })
      expect(result.current.detailSkillId).toBeNull()
    })

    it("openEdit sets editor target to edit and clears any open detail", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openDetail("other"))
      act(() => result.current.openEdit("skill-99"))
      expect(result.current.editorTarget).toEqual({ mode: "edit", skillId: "skill-99" })
      expect(result.current.detailSkillId).toBeNull()
    })

    it("closeEditor clears the editor target", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openCreate())
      act(() => result.current.closeEditor())
      expect(result.current.editorTarget).toBeNull()
    })
  })

  describe("importStaging", () => {
    it("setImportStaging accepts payload and null", () => {
      const staging: ImportStaging = {
        drafts: [{ name: "x", content: "..." }],
        sourceLabel: "Markdown files (1)",
        parseErrors: [],
      }
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setImportStaging(staging))
      expect(result.current.importStaging).toEqual(staging)
      act(() => result.current.setImportStaging(null))
      expect(result.current.importStaging).toBeNull()
    })

    it("setImportStaging carries parseErrors when present", () => {
      const staging: ImportStaging = {
        drafts: [],
        sourceLabel: "Bad batch",
        parseErrors: [{ name: "broken.md", error: "unreadable" }],
      }
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setImportStaging(staging))
      expect(result.current.importStaging?.parseErrors).toHaveLength(1)
    })
  })

  describe("deleteTarget", () => {
    it("setDeleteTarget accepts payload and null", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setDeleteTarget({ skillId: "s1", name: "Skill One" }))
      expect(result.current.deleteTarget).toEqual({ skillId: "s1", name: "Skill One" })
      act(() => result.current.setDeleteTarget(null))
      expect(result.current.deleteTarget).toBeNull()
    })
  })
})
