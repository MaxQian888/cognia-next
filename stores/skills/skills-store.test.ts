import { act, renderHook } from "@testing-library/react"
import { useSkillsStore, type ImportStaging, type SkillFilters } from "./skills-store"
import { DEFAULT_SKILL_PANEL_PREFS } from "@/lib/skills/preferences"
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
  editorWorkspace: {
    activeSkillId: null,
    openFiles: [],
    activeFileId: null,
    rightPaneOpen: true,
  },
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
      act(() => result.current.setFilters({ category: "development", sort: "usage" }))
      act(() => result.current.setQuery("yaml"))
      expect(result.current.filters.query).toBe("yaml")
      expect(result.current.filters.category).toBe("development")
      expect(result.current.filters.sort).toBe("usage")
    })

    it("resetFilters returns to the documented defaults", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setFilters({ query: "x", category: "development", sort: "usage" }))
      act(() => result.current.resetFilters())
      expect(result.current.filters).toEqual(DEFAULT_FILTERS)
    })
  })

  describe("hydrateFromPrefs", () => {
    it("seeds tab, sort, and status from prefs when no lastView is given", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() =>
        result.current.hydrateFromPrefs({
          ...DEFAULT_SKILL_PANEL_PREFS,
          defaultTab: "browse",
          defaultSort: "updated",
          defaultStatusFilter: "enabled",
        })
      )
      expect(result.current.activeTab).toBe("browse")
      expect(result.current.filters.sort).toBe("updated")
      expect(result.current.filters.status).toBe("enabled")
      // Category/source are left at defaults without a lastView.
      expect(result.current.filters.category).toBe("all")
      expect(result.current.filters.source).toBe("all")
    })

    it("restores the full last view when provided", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() =>
        result.current.hydrateFromPrefs(DEFAULT_SKILL_PANEL_PREFS, {
          tab: "analytics",
          sort: "usage",
          category: "development",
          source: "custom",
          status: "disabled",
          tag: "yaml",
        })
      )
      expect(result.current.activeTab).toBe("analytics")
      expect(result.current.filters).toMatchObject({
        sort: "usage",
        category: "development",
        source: "custom",
        status: "disabled",
        tag: "yaml",
      })
    })

    it("preserves the ephemeral search query across hydration", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setQuery("keep me"))
      act(() => result.current.hydrateFromPrefs(DEFAULT_SKILL_PANEL_PREFS))
      expect(result.current.filters.query).toBe("keep me")
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

    it("setImportStaging carries bundle-specific fields (resources, flavor, nativeDirectory, canonicalId)", () => {
      const staging: ImportStaging = {
        drafts: [
          {
            name: "Reviewer",
            content: "body",
            canonicalId: "bundle:zip:reviewer",
            nativeDirectory: "/tmp/reviewer",
            resources: [
              { kind: "script", name: "x.sh", path: "scripts/x.sh", content: "#!/bin/bash\n" },
            ],
          },
        ],
        sourceLabel: "reviewer.zip",
        parseErrors: [],
        flavor: "codex",
      }
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.setImportStaging(staging))
      expect(result.current.importStaging?.flavor).toBe("codex")
      expect(result.current.importStaging?.drafts[0].canonicalId).toBe("bundle:zip:reviewer")
      expect(result.current.importStaging?.drafts[0].nativeDirectory).toBe("/tmp/reviewer")
      expect(result.current.importStaging?.drafts[0].resources).toHaveLength(1)
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

  describe("editorWorkspace", () => {
    it("openSkillInEditor seeds the workspace with the main file", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openSkillInEditor("skill_1", "body content"))
      const ws = result.current.editorWorkspace
      expect(ws.activeSkillId).toBe("skill_1")
      expect(ws.openFiles).toHaveLength(1)
      expect(ws.openFiles[0]).toMatchObject({
        id: "main",
        kind: "main",
        path: "SKILL.md",
        language: "markdown",
        draftContent: "body content",
        savedContent: "body content",
      })
      expect(ws.activeFileId).toBe("main")
    })

    it("openFile dedupes by id and focuses it", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openSkillInEditor("skill_1", "body"))
      const file = {
        id: "res_1",
        kind: "resource" as const,
        resourceId: "res_1",
        path: "scripts/x.sh",
        language: "shell" as const,
        draftContent: "echo",
        savedContent: "echo",
      }
      act(() => result.current.openFile(file))
      expect(result.current.editorWorkspace.openFiles).toHaveLength(2)
      act(() => result.current.openFile({ ...file, draftContent: "new" }))
      // Same id → list does not grow.
      expect(result.current.editorWorkspace.openFiles).toHaveLength(2)
      expect(result.current.editorWorkspace.activeFileId).toBe("res_1")
    })

    it("updateDraftContent mutates the draft without touching savedContent", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openSkillInEditor("skill_1", "body"))
      act(() => result.current.updateDraftContent("main", "edited"))
      const f = result.current.editorWorkspace.openFiles[0]
      expect(f.draftContent).toBe("edited")
      expect(f.savedContent).toBe("body")
    })

    it("markSaved syncs savedContent", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openSkillInEditor("skill_1", "body"))
      act(() => result.current.updateDraftContent("main", "edited"))
      act(() => result.current.markSaved("main", "edited"))
      const f = result.current.editorWorkspace.openFiles[0]
      expect(f.savedContent).toBe(f.draftContent)
    })

    it("closeFile removes the file and updates activeFileId", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openSkillInEditor("skill_1", "body"))
      act(() => result.current.closeFile("main", true))
      expect(result.current.editorWorkspace.openFiles).toHaveLength(0)
      expect(result.current.editorWorkspace.activeFileId).toBeNull()
    })

    it("closeFile keeps activeFileId when closing a non-active tab", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openSkillInEditor("skill_1", "body"))
      act(() =>
        result.current.openFile({
          id: "r1",
          kind: "resource",
          resourceId: "r1",
          path: "x.sh",
          language: "shell",
          draftContent: "",
          savedContent: "",
        })
      )
      act(() => result.current.setActiveFile("main"))
      act(() => result.current.closeFile("r1", true))
      expect(result.current.editorWorkspace.activeFileId).toBe("main")
    })

    it("discardDrafts resets every file's draft to its saved content", () => {
      const { result } = renderHook(() => useSkillsStore())
      act(() => result.current.openSkillInEditor("skill_1", "body"))
      act(() => result.current.updateDraftContent("main", "edited"))
      act(() => result.current.discardDrafts())
      expect(result.current.editorWorkspace.openFiles[0].draftContent).toBe("body")
    })

    it("toggleRightPane flips the boolean", () => {
      const { result } = renderHook(() => useSkillsStore())
      const before = result.current.editorWorkspace.rightPaneOpen
      act(() => result.current.toggleRightPane())
      expect(result.current.editorWorkspace.rightPaneOpen).toBe(!before)
    })
  })
})
