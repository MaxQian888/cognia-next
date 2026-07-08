/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { DEFAULT_WORKFLOW_FILTERS, useWorkflowLibraryStore } from "./workflow-library-store"

beforeEach(() => {
  localStorage.clear()
  // Reset to the documented initial state between tests.
  useWorkflowLibraryStore.setState({
    viewMode: "grid",
    sort: "updated",
    filters: { ...DEFAULT_WORKFLOW_FILTERS },
    query: "",
    currentFolderId: ROOT_FOLDER_ID,
    selection: new Set<string>(),
    selectionMode: false,
    moveDialogTarget: null,
    deleteDialogTarget: null,
    tagDialogTarget: null,
    createFolderParentId: null,
    renameFolderTarget: null,
  })
})

describe("initial state", () => {
  it("starts with documented defaults", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    expect(result.current.viewMode).toBe("grid")
    expect(result.current.sort).toBe("updated")
    expect(result.current.filters).toEqual(DEFAULT_WORKFLOW_FILTERS)
    expect(result.current.query).toBe("")
    expect(result.current.currentFolderId).toBe(ROOT_FOLDER_ID)
    expect(result.current.selection.size).toBe(0)
    expect(result.current.selectionMode).toBe(false)
  })
})

describe("preference setters", () => {
  it("updates view mode and sort", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.setViewMode("list"))
    act(() => result.current.setSort("nameAsc"))
    expect(result.current.viewMode).toBe("list")
    expect(result.current.sort).toBe("nameAsc")
  })

  it("merges filter patches and resets them", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.setFilters({ type: "template" }))
    act(() => result.current.setFilters({ hasTrigger: true }))
    expect(result.current.filters).toEqual({
      type: "template",
      hasTrigger: true,
      recentlyFailed: false,
    })
    act(() => result.current.resetFilters())
    expect(result.current.filters).toEqual(DEFAULT_WORKFLOW_FILTERS)
  })

  it("sets the search query", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.setQuery("digest"))
    expect(result.current.query).toBe("digest")
  })
})

describe("folder navigation", () => {
  it("enterFolder sets the folder and clears selection + selection mode", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => {
      result.current.toggleSelection("wf_a")
      result.current.setSelectionMode(true)
    })
    act(() => result.current.enterFolder("wff_1"))
    expect(result.current.currentFolderId).toBe("wff_1")
    expect(result.current.selection.size).toBe(0)
    expect(result.current.selectionMode).toBe(false)
  })

  it("goToRoot returns to the root sentinel", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.enterFolder("wff_1"))
    act(() => result.current.goToRoot())
    expect(result.current.currentFolderId).toBe(ROOT_FOLDER_ID)
  })

  it("setCurrentFolder swaps folder without touching selection", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.toggleSelection("wf_a"))
    act(() => result.current.setCurrentFolder("wff_2"))
    expect(result.current.currentFolderId).toBe("wff_2")
    expect(result.current.selection.has("wf_a")).toBe(true)
  })
})

describe("selection", () => {
  it("toggles ids on and off", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.toggleSelection("wf_a"))
    act(() => result.current.toggleSelection("wf_b"))
    expect(result.current.selection.has("wf_a")).toBe(true)
    expect(result.current.selection.has("wf_b")).toBe(true)
    act(() => result.current.toggleSelection("wf_a"))
    expect(result.current.selection.has("wf_a")).toBe(false)
  })

  it("selectAll replaces the set and clearSelection empties it", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.selectAll(["wf_a", "wf_b", "wf_c"]))
    expect(result.current.selection.size).toBe(3)
    act(() => {
      result.current.setSelectionMode(true)
      result.current.clearSelection()
    })
    expect(result.current.selection.size).toBe(0)
    expect(result.current.selectionMode).toBe(false)
  })
})

describe("dialog targets", () => {
  it("opens and closes move / delete / tag dialogs", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.openMoveDialog(["wf_a"]))
    expect(result.current.moveDialogTarget).toEqual({ ids: ["wf_a"] })
    act(() => result.current.closeMoveDialog())
    expect(result.current.moveDialogTarget).toBeNull()

    act(() => result.current.openDeleteDialog(["wf_a", "wf_b"]))
    expect(result.current.deleteDialogTarget).toEqual({ ids: ["wf_a", "wf_b"] })
    act(() => result.current.closeDeleteDialog())
    expect(result.current.deleteDialogTarget).toBeNull()

    act(() => result.current.openTagDialog(["wf_a"]))
    expect(result.current.tagDialogTarget).toEqual({ ids: ["wf_a"] })
    act(() => result.current.closeTagDialog())
    expect(result.current.tagDialogTarget).toBeNull()
  })

  it("opens and closes create / rename folder dialogs", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => result.current.openCreateFolder("wff_parent"))
    expect(result.current.createFolderParentId).toBe("wff_parent")
    act(() => result.current.closeCreateFolder())
    expect(result.current.createFolderParentId).toBeNull()

    act(() => result.current.openRenameFolder("wff_1", "Reports"))
    expect(result.current.renameFolderTarget).toEqual({ id: "wff_1", name: "Reports" })
    act(() => result.current.closeRenameFolder())
    expect(result.current.renameFolderTarget).toBeNull()
  })
})

describe("persistence", () => {
  it("persists only view/sort/filters, never selection or query", () => {
    const { result } = renderHook(() => useWorkflowLibraryStore())
    act(() => {
      result.current.setViewMode("list")
      result.current.setSort("runCount")
      result.current.setFilters({ type: "user" })
      result.current.setQuery("secret")
      result.current.toggleSelection("wf_a")
    })
    const raw = localStorage.getItem("workflow-library-prefs")
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw as string)
    expect(persisted.state.viewMode).toBe("list")
    expect(persisted.state.sort).toBe("runCount")
    expect(persisted.state.filters.type).toBe("user")
    expect(persisted.state).not.toHaveProperty("query")
    expect(persisted.state).not.toHaveProperty("selection")
  })
})
