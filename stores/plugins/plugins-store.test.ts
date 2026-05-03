import { act, renderHook } from "@testing-library/react"
import {
  usePluginsStore,
  DEFAULT_PLUGIN_FILTERS,
  type PluginImportStaging,
  type ConflictSummary,
} from "./plugins-store"
import * as barrel from "./"

it("barrel re-exports usePluginsStore", () => {
  expect(barrel.usePluginsStore).toBe(usePluginsStore)
})

const RESET = {
  activeTab: "installed" as const,
  filters: DEFAULT_PLUGIN_FILTERS,
  selection: new Set<string>(),
  detailPluginId: null,
  filterSheetOpen: false,
  configTarget: null,
  importStaging: null,
  deleteTarget: null,
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
    expect(result.current.filters).toEqual(DEFAULT_PLUGIN_FILTERS)
    expect(result.current.selection.size).toBe(0)
    expect(result.current.detailPluginId).toBeNull()
    expect(result.current.filterSheetOpen).toBe(false)
    expect(result.current.configTarget).toBeNull()
    expect(result.current.importStaging).toBeNull()
    expect(result.current.deleteTarget).toBeNull()
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

    it("openConfigure clears any open detail panel", () => {
      const { result } = renderHook(() => usePluginsStore())
      act(() => result.current.openDetail("plugin_a"))
      act(() => result.current.openConfigure("plugin_a"))
      expect(result.current.configTarget).toEqual({ pluginId: "plugin_a" })
      expect(result.current.detailPluginId).toBeNull()
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
