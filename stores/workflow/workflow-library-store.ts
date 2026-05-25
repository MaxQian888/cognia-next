// Zustand store for the desktop workflow library entry page (ADR-0011 library
// upgrade). Mirrors `stores/plugins/plugins-store.ts`: view/sort/filter prefs
// persist to localStorage via `partialize`; everything else (search query,
// current folder, multi-select, dialog targets) is ephemeral session state.
//
// The workflow rows themselves live in Dexie (`lib/db/workflows.ts`) and are
// read through `useLiveQuery`; this store holds only UI intent.

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"

export type WorkflowViewMode = "grid" | "list"

export type WorkflowSortMode = "nameAsc" | "nameDesc" | "updated" | "created" | "runCount"

export type WorkflowTypeFilter = "all" | "user" | "template" | "builtin"

export interface WorkflowLibraryFilters {
  /** Workflow provenance facet. */
  type: WorkflowTypeFilter
  /** Keep only workflows that contain at least one trigger node. */
  hasTrigger: boolean
  /** Keep only workflows whose most recent run failed. */
  recentlyFailed: boolean
}

/** Dialog target carrying the workflow ids it acts on. */
export interface WorkflowIdsTarget {
  ids: string[]
}

interface WorkflowLibraryState {
  // ── Persisted preferences ──────────────────────────────────────────────
  viewMode: WorkflowViewMode
  sort: WorkflowSortMode
  filters: WorkflowLibraryFilters

  // ── Ephemeral session state ──────────────────────────────────────────────
  /** Debounced search text (matched on name/description/tags). */
  query: string
  /** Folder currently being browsed; `ROOT_FOLDER_ID` is the library root. */
  currentFolderId: string
  /** Selected workflow ids for batch operations. */
  selection: Set<string>
  /** When true, cards/rows render their selection checkbox. */
  selectionMode: boolean
  /** Non-null opens the move-to-folder dialog for these workflow ids. */
  moveDialogTarget: WorkflowIdsTarget | null
  /** Non-null opens the delete confirmation for these workflow ids. */
  deleteDialogTarget: WorkflowIdsTarget | null
  /** Non-null opens the add-tag dialog for these workflow ids. */
  tagDialogTarget: WorkflowIdsTarget | null
  /** Non-null opens the create-folder dialog under this parent folder id. */
  createFolderParentId: string | null
  /** Non-null opens the rename-folder dialog for this folder. */
  renameFolderTarget: { id: string; name: string } | null

  setViewMode: (mode: WorkflowViewMode) => void
  setSort: (sort: WorkflowSortMode) => void
  setFilters: (patch: Partial<WorkflowLibraryFilters>) => void
  resetFilters: () => void
  setQuery: (query: string) => void

  enterFolder: (id: string) => void
  goToRoot: () => void
  setCurrentFolder: (id: string) => void

  toggleSelection: (id: string) => void
  selectAll: (ids: string[]) => void
  clearSelection: () => void
  setSelectionMode: (on: boolean) => void

  openMoveDialog: (ids: string[]) => void
  closeMoveDialog: () => void
  openDeleteDialog: (ids: string[]) => void
  closeDeleteDialog: () => void
  openTagDialog: (ids: string[]) => void
  closeTagDialog: () => void
  openCreateFolder: (parentId: string) => void
  closeCreateFolder: () => void
  openRenameFolder: (id: string, name: string) => void
  closeRenameFolder: () => void
}

export const DEFAULT_WORKFLOW_FILTERS: WorkflowLibraryFilters = {
  type: "all",
  hasTrigger: false,
  recentlyFailed: false,
}

export const useWorkflowLibraryStore = create<WorkflowLibraryState>()(
  persist(
    (set) => ({
      viewMode: "grid",
      sort: "updated",
      filters: DEFAULT_WORKFLOW_FILTERS,

      query: "",
      currentFolderId: ROOT_FOLDER_ID,
      selection: new Set<string>(),
      selectionMode: false,
      moveDialogTarget: null,
      deleteDialogTarget: null,
      tagDialogTarget: null,
      createFolderParentId: null,
      renameFolderTarget: null,

      setViewMode: (mode) => set({ viewMode: mode }),
      setSort: (sort) => set({ sort }),
      setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
      resetFilters: () => set({ filters: DEFAULT_WORKFLOW_FILTERS }),
      setQuery: (query) => set({ query }),

      // Changing folder swaps the visible item set, so any active selection
      // would point at off-screen rows — clear it and exit selection mode.
      enterFolder: (id) => set({ currentFolderId: id, selection: new Set(), selectionMode: false }),
      goToRoot: () =>
        set({
          currentFolderId: ROOT_FOLDER_ID,
          selection: new Set(),
          selectionMode: false,
        }),
      setCurrentFolder: (id) => set({ currentFolderId: id }),

      toggleSelection: (id) =>
        set((s) => {
          const next = new Set(s.selection)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return { selection: next }
        }),
      selectAll: (ids) => set({ selection: new Set(ids) }),
      clearSelection: () => set({ selection: new Set(), selectionMode: false }),
      setSelectionMode: (on) => set({ selectionMode: on }),

      openMoveDialog: (ids) => set({ moveDialogTarget: { ids } }),
      closeMoveDialog: () => set({ moveDialogTarget: null }),
      openDeleteDialog: (ids) => set({ deleteDialogTarget: { ids } }),
      closeDeleteDialog: () => set({ deleteDialogTarget: null }),
      openTagDialog: (ids) => set({ tagDialogTarget: { ids } }),
      closeTagDialog: () => set({ tagDialogTarget: null }),
      openCreateFolder: (parentId) => set({ createFolderParentId: parentId }),
      closeCreateFolder: () => set({ createFolderParentId: null }),
      openRenameFolder: (id, name) => set({ renameFolderTarget: { id, name } }),
      closeRenameFolder: () => set({ renameFolderTarget: null }),
    }),
    {
      name: "workflow-library-prefs",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only the view/sort/filter preferences survive reloads. Folder, search,
      // and selection are session state and reset each load.
      partialize: (s) => ({ viewMode: s.viewMode, sort: s.sort, filters: s.filters }),
    }
  )
)
