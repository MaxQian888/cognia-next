import { act, renderHook } from "@testing-library/react"
import {
  usePluginsStore,
  DEFAULT_PLUGIN_FILTERS,
  deriveSectionFromTab,
  type PluginImportStaging,
  type ConflictSummary,
} from "./plugins-store"
import * as barrel from "./"

it("barrel re-exports usePluginsStore", () => {
  expect(barrel.usePluginsStore).toBe(usePluginsStore)
})

const RESET = {
  activeTab: "installed" as const,
  activeSection: "library" as const,
  librarySubFilter: "all" as const,
  governanceView: "permissions" as const,
  detailSubTab: "overview" as const,
  listViewMode: "list" as const,
  filters: DEFAULT_PLUGIN_FILTERS,
  selection: new Set<string>(),
  detailPluginId: null,
  filterSheetOpen: false,
  configTarget: null,
  importStaging: null,
  deleteTarget: null,
  deleteQueue: [],
  permissionReviewTarget: null,
  conflictDialogTarget: null,
  rollbackTarget: null,
}

describe("usePluginsStore", () => {
  beforeEach(() => {
    usePluginsStore.setState(RESET)
  })

  it("starts with documented defaults", () => {
    const { result } = renderHook(() => usePluginsStore())
    expect(result.current.activeTab).toBe("installed")
    expect(result.current.activeSection).toBe("library")
    expect(result.current.librarySubFilter).toBe("all")
    expect(result.current.governanceView).toBe("permissions")
    expect(result.current.detailSubTab).toBe("overview")
    expect(result.current.listViewMode).toBe("list")
    expect(result.current.filters).toEqual(DEFAULT_PLUGIN_FILTERS)
    expect(result.current.selection.size).toBe(0)
    expect(result.current.detailPluginId).toBeNull()
    expect(result.current.filterSheetOpen).toBe(false)
    expect(result.current.configTarget).toBeNull()
    expect(result.current.importStaging).toBeNull()
    expect(result.current.deleteTarget).toBeNull()
    expect(result.current.deleteQueue).toEqual([])
    expect(result.current.permissionReviewTarget).toBeNull()
    expect(result.current.conflictDialogTarget).toBeNull()
    expect(result.current.rollbackTarget).toBeNull()
  })

  describe("tabs and filters", () => {
    it("setActiveTab switches across all 7 tab values", () => {
      const { result } = renderHook(() => usePluginsStore())
      const tabs = [
        "browse",
        "configure",
        "permissions",
        "scheduled",
        "analytics",
        "devtools",
        "installed",
      ] as const
      for (const tab of tabs) {
        act(() => result.current.setActiveTab(tab))
        expect(result.current.activeTab).toBe(tab)
      }
    })

    it("setActiveTab mirrors the tab into activeSection / governanceView / librarySubFilter", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setActiveTab("browse"))
      expect(result.current.activeSection).toBe("discover")
      act(() => result.current.setActiveTab("permissions"))
      expect(result.current.activeSection).toBe("governance")
      expect(result.current.governanceView).toBe("permissions")
      act(() => result.current.setActiveTab("scheduled"))
      expect(result.current.governanceView).toBe("scheduled")
      act(() => result.current.setActiveTab("analytics"))
      expect(result.current.governanceView).toBe("analytics")
      act(() => result.current.setActiveTab("devtools"))
      expect(result.current.activeSection).toBe("devtools")
      act(() => result.current.setActiveTab("configure"))
      expect(result.current.activeSection).toBe("library")
      expect(result.current.librarySubFilter).toBe("configurable")
      expect(result.current.detailSubTab).toBe("configure")
      act(() => result.current.setActiveTab("installed"))
      expect(result.current.activeSection).toBe("library")
    })

    it("deriveSectionFromTab is exhaustive across all 7 tabs", () => {
      const tabs = [
        "installed",
        "browse",
        "configure",
        "permissions",
        "scheduled",
        "analytics",
        "devtools",
      ] as const
      for (const tab of tabs) {
        const derived = deriveSectionFromTab(tab)
        expect(typeof derived.section).toBe("string")
        expect(["library", "discover", "governance", "devtools"]).toContain(derived.section)
      }
    })

    it("setActiveSection sets the section without touching filters", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setActiveSection("discover"))
      expect(result.current.activeSection).toBe("discover")
      expect(result.current.filters).toEqual(DEFAULT_PLUGIN_FILTERS)
    })

    it("setGovernanceView switches across the four aggregate views", () => {
      const { result } = renderHook(() => usePluginsStore())
      const views = ["scheduled", "analytics", "audit", "permissions"] as const
      for (const view of views) {
        act(() => result.current.setGovernanceView(view))
        expect(result.current.governanceView).toBe(view)
      }
    })

    it("setDetailSubTab switches across the 5 sub-tab values", () => {
      const { result } = renderHook(() => usePluginsStore())
      const subs = ["capabilities", "configure", "permissions", "data", "overview"] as const
      for (const sub of subs) {
        act(() => result.current.setDetailSubTab(sub))
        expect(result.current.detailSubTab).toBe(sub)
      }
    })

    it("setListViewMode toggles between list and card", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setListViewMode("card"))
      expect(result.current.listViewMode).toBe("card")
      act(() => result.current.setListViewMode("list"))
      expect(result.current.listViewMode).toBe("list")
    })

    it("setLibrarySubFilter='enabled' mutates filters.status to enabled and clears hasUpdate", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setFilters({ hasUpdate: true }))
      act(() => result.current.setLibrarySubFilter("enabled"))
      expect(result.current.librarySubFilter).toBe("enabled")
      expect(result.current.filters.status).toBe("enabled")
      expect(result.current.filters.hasUpdate).toBe(false)
    })

    it("setLibrarySubFilter='updates' flips filters.hasUpdate on", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setLibrarySubFilter("updates"))
      expect(result.current.filters.hasUpdate).toBe(true)
      expect(result.current.filters.status).toBe("all")
    })

    it("setLibrarySubFilter='errored' mutates filters.status to the Dexie 'error' enum value", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setLibrarySubFilter("errored"))
      // Sub-filter UX label is "errored"; the underlying row.status enum is
      // "error" — the store maps between them so the existing filter
      // pipeline matches actual Dexie rows.
      expect(result.current.filters.status).toBe("error")
      expect(result.current.filters.configurable).toBe(false)
    })

    it("setLibrarySubFilter='configurable' turns the configurable predicate on", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setFilters({ status: "enabled", hasUpdate: true }))
      act(() => result.current.setLibrarySubFilter("configurable"))
      expect(result.current.librarySubFilter).toBe("configurable")
      expect(result.current.filters.status).toBe("all")
      expect(result.current.filters.hasUpdate).toBe(false)
      expect(result.current.filters.configurable).toBe(true)
    })

    it("setLibrarySubFilter='all' resets the filter axes it owns including configurable", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setLibrarySubFilter("configurable"))
      act(() => result.current.setLibrarySubFilter("all"))
      expect(result.current.filters.status).toBe("all")
      expect(result.current.filters.hasUpdate).toBe(false)
      expect(result.current.filters.configurable).toBe(false)
    })

    it("setFilters does a partial merge", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() =>
        result.current.setFilters({
          query: "hello",
          sort: "rating",
          signedOnly: true,
        })
      )
      expect(result.current.filters).toEqual({
        ...DEFAULT_PLUGIN_FILTERS,
        query: "hello",
        sort: "rating",
        signedOnly: true,
      })
    })

    it("resetFilters restores documented defaults", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() =>
        result.current.setFilters({
          query: "x",
          capability: "tools",
          status: "error",
          hasUpdate: true,
        })
      )
      act(() => result.current.resetFilters())
      expect(result.current.filters).toEqual(DEFAULT_PLUGIN_FILTERS)
    })

    it("setQuery only mutates the query field", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setFilters({ capability: "tools", sort: "usage" }))
      act(() => result.current.setQuery("alpha"))
      expect(result.current.filters.query).toBe("alpha")
      expect(result.current.filters.capability).toBe("tools")
      expect(result.current.filters.sort).toBe("usage")
    })
  })

  describe("selection", () => {
    it("toggleSelection adds and removes ids", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.toggleSelection("a"))
      act(() => result.current.toggleSelection("b"))
      expect(result.current.selection.size).toBe(2)
      act(() => result.current.toggleSelection("a"))
      expect(result.current.selection.size).toBe(1)
      expect(result.current.selection.has("b")).toBe(true)
    })

    it("selectAll replaces the selection set", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.toggleSelection("z"))
      act(() => result.current.selectAll(["a", "b", "c"]))
      expect(result.current.selection.size).toBe(3)
      expect(result.current.selection.has("a")).toBe(true)
      expect(result.current.selection.has("z")).toBe(false)
    })

    it("clearSelection empties the set", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.selectAll(["x", "y"]))
      act(() => result.current.clearSelection())
      expect(result.current.selection.size).toBe(0)
    })
  })

  describe("dialog targets", () => {
    it("openDetail / closeDetail toggle the detail panel target", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.openDetail("plugin_a"))
      expect(result.current.detailPluginId).toBe("plugin_a")
      act(() => result.current.closeDetail())
      expect(result.current.detailPluginId).toBeNull()
    })

    it("openConfigure now routes through the detail pane on the Configure sub-tab", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.openConfigure("plugin_a"))
      // configTarget stays set as a back-compat shim for legacy consumers,
      // but the detail pane is the primary surface from this release on.
      expect(result.current.configTarget).toEqual({ pluginId: "plugin_a" })
      expect(result.current.detailPluginId).toBe("plugin_a")
      expect(result.current.detailSubTab).toBe("configure")
      expect(result.current.activeSection).toBe("library")
      act(() => result.current.closeConfigure())
      expect(result.current.configTarget).toBeNull()
    })

    it("filter sheet toggle persists", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setFilterSheetOpen(true))
      expect(result.current.filterSheetOpen).toBe(true)
      act(() => result.current.setFilterSheetOpen(false))
      expect(result.current.filterSheetOpen).toBe(false)
    })

    it("setImportStaging persists the staged batch", () => {
      const { result } = renderHook(() => usePluginsStore())
      const staging: PluginImportStaging = {
        drafts: [
          {
            id: "p1",
            name: "Plugin 1",
            version: "1.0.0",
            manifest: { id: "p1", name: "Plugin 1", version: "1.0.0" },
            sourceLabel: "local",
          },
        ],
        sourceLabel: "local bundle",
        parseErrors: [],
      }
      act(() => result.current.setImportStaging(staging))
      expect(result.current.importStaging).toEqual(staging)
      act(() => result.current.setImportStaging(null))
      expect(result.current.importStaging).toBeNull()
    })

    it("setDeleteTarget persists the delete target", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setDeleteTarget({ pluginId: "plugin_x", name: "X" }))
      expect(result.current.deleteTarget).toEqual({
        pluginId: "plugin_x",
        name: "X",
      })
      act(() => result.current.setDeleteTarget(null))
      expect(result.current.deleteTarget).toBeNull()
    })

    it("enqueueDeleteTargets pops the head into deleteTarget and stores the rest", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() =>
        result.current.enqueueDeleteTargets([
          { pluginId: "a", name: "A" },
          { pluginId: "b", name: "B" },
          { pluginId: "c", name: "C" },
        ])
      )
      expect(result.current.deleteTarget).toEqual({ pluginId: "a", name: "A" })
      expect(result.current.deleteQueue).toEqual([
        { pluginId: "b", name: "B" },
        { pluginId: "c", name: "C" },
      ])
    })

    it("enqueueDeleteTargets with an empty list clears both target and queue", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setDeleteTarget({ pluginId: "x", name: "X" }))
      act(() => result.current.enqueueDeleteTargets([]))
      expect(result.current.deleteTarget).toBeNull()
      expect(result.current.deleteQueue).toEqual([])
    })

    it("advanceDeleteQueue walks the queue until it's empty, then clears", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() =>
        result.current.enqueueDeleteTargets([
          { pluginId: "a", name: "A" },
          { pluginId: "b", name: "B" },
        ])
      )
      act(() => result.current.advanceDeleteQueue())
      expect(result.current.deleteTarget).toEqual({ pluginId: "b", name: "B" })
      expect(result.current.deleteQueue).toEqual([])
      act(() => result.current.advanceDeleteQueue())
      expect(result.current.deleteTarget).toBeNull()
    })

    it("clearDeleteQueue drops pending entries without clearing the active target", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() =>
        result.current.enqueueDeleteTargets([
          { pluginId: "a", name: "A" },
          { pluginId: "b", name: "B" },
        ])
      )
      act(() => result.current.clearDeleteQueue())
      expect(result.current.deleteTarget).toEqual({ pluginId: "a", name: "A" })
      expect(result.current.deleteQueue).toEqual([])
    })

    it("openPermissionReview / closePermissionReview toggle the review dialog", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.openPermissionReview("plugin_a"))
      expect(result.current.permissionReviewTarget).toEqual({
        pluginId: "plugin_a",
      })
      act(() => result.current.closePermissionReview())
      expect(result.current.permissionReviewTarget).toBeNull()
    })

    it("setConflictDialogTarget persists conflict summaries", () => {
      const { result } = renderHook(() => usePluginsStore())
      const summary: ConflictSummary = {
        pluginId: "plugin_b",
        conflicts: [
          { severity: "high", message: "version mismatch" },
          { severity: "low", message: "duplicate tool name" },
        ],
      }
      act(() => result.current.setConflictDialogTarget(summary))
      expect(result.current.conflictDialogTarget).toEqual(summary)
      act(() => result.current.setConflictDialogTarget(null))
      expect(result.current.conflictDialogTarget).toBeNull()
    })

    it("setRollbackTarget toggles the rollback dialog target", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.setRollbackTarget("plugin_z"))
      expect(result.current.rollbackTarget).toBe("plugin_z")
      act(() => result.current.setRollbackTarget(null))
      expect(result.current.rollbackTarget).toBeNull()
    })
  })
})
