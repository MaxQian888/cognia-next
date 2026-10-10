// View state of the Files page (ADR-0223). Layout, column sort, workspace
// scope, the sidebar's width and open folders, and whether the template strip
// is collapsed persist per device; the place, lens, search, filters, preview
// selection and dialog targets are session state. The items themselves live
// in Dexie and the artifact store — this store holds only UI intent.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { DEFAULT_FILES_LENS, DEFAULT_FILES_SECTION } from "@/lib/files-library/deep-link"
import type { FilesFormat } from "@/lib/files-library/format"
import type {
  FilesLens,
  FilesModifiedWithin,
  FilesProjectScope,
  FilesSection,
  FilesSizeBand,
  FilesSort,
} from "@/lib/files-library/types"
import { persistLocalStorage } from "@/stores/persist-storage"

export type FilesViewMode = "grid" | "list"

/** A folder dialog: create under `parentId`, or rename `folderId`. */
export type FilesFolderDialog =
  { mode: "create"; parentId: string } | { mode: "rename"; folderId: string; name: string } | null

/** The popover filters, without the workspace scope (a persisted preference). */
export interface FilesViewFilters {
  formats: FilesFormat[]
  modified: FilesModifiedWithin
  size: FilesSizeBand
}

export const DEFAULT_FILES_VIEW_FILTERS: FilesViewFilters = {
  formats: [],
  modified: "any",
  size: "any",
}

/** Sidebar width bounds, in pixels. */
export const FILES_SIDEBAR_MIN_PX = 200
export const FILES_SIDEBAR_MAX_PX = 400
export const FILES_SIDEBAR_DEFAULT_PX = 248

function clampSidebar(px: number): number {
  if (!Number.isFinite(px)) return FILES_SIDEBAR_DEFAULT_PX
  return Math.min(FILES_SIDEBAR_MAX_PX, Math.max(FILES_SIDEBAR_MIN_PX, Math.round(px)))
}

interface FilesLibraryState {
  // Persisted preferences
  viewMode: FilesViewMode
  /** A clicked column header; null = the view's own default order. */
  sort: FilesSort | null
  projectScope: FilesProjectScope
  sidebarWidthPx: number
  /** Folders open in the sidebar tree. */
  expandedFolderIds: string[]
  /** The Suggested template strip is folded away. */
  templatesCollapsed: boolean

  // Session state
  section: FilesSection
  lens: FilesLens
  search: string
  filters: FilesViewFilters
  /** Entry key shown in the preview pane. */
  selectedKey: string | null
  /** Entry keys the move-to-folder dialog acts on. */
  moveTarget: string[] | null
  /** Entry key the rename dialog acts on. */
  renameTarget: string | null
  /** Entry keys the delete-forever confirmation acts on. */
  deleteForeverTarget: string[] | null
  emptyTrashOpen: boolean
  folderDialog: FilesFolderDialog
  /** Folder id the delete-folder confirmation acts on. */
  deleteFolderTarget: string | null
  /** Entry key the "Save as template" dialog saves. */
  saveTemplateTarget: string | null
  /** Entry keys the share dialog shares as one link. */
  shareTarget: string[] | null

  setViewMode: (mode: FilesViewMode) => void
  setSort: (sort: FilesSort | null) => void
  setProjectScope: (scope: FilesProjectScope) => void
  setSidebarWidth: (px: number) => void
  setFolderExpanded: (folderId: string, expanded: boolean) => void
  setTemplatesCollapsed: (collapsed: boolean) => void
  /** Changing place closes the preview. */
  setSection: (section: FilesSection) => void
  setLens: (lens: FilesLens) => void
  setSearch: (search: string) => void
  setFilters: (patch: Partial<FilesViewFilters>) => void
  resetFilters: () => void
  select: (key: string | null) => void
  openMove: (keys: string[]) => void
  closeMove: () => void
  openRename: (key: string) => void
  closeRename: () => void
  openDeleteForever: (keys: string[]) => void
  closeDeleteForever: () => void
  setEmptyTrashOpen: (open: boolean) => void
  openFolderDialog: (dialog: Exclude<FilesFolderDialog, null>) => void
  closeFolderDialog: () => void
  openDeleteFolder: (folderId: string) => void
  closeDeleteFolder: () => void
  openSaveTemplate: (key: string) => void
  closeSaveTemplate: () => void
  openShare: (keys: string[]) => void
  closeShare: () => void
}

/** What a v1 persisted blob (ADR-0200) carried. */
interface PersistedV1 {
  viewMode?: FilesViewMode
  projectScope?: FilesProjectScope
}

type Persisted = Pick<
  FilesLibraryState,
  | "viewMode"
  | "sort"
  | "projectScope"
  | "sidebarWidthPx"
  | "expandedFolderIds"
  | "templatesCollapsed"
>

/**
 * v1 → v2: the layout and workspace scope carry over. v1's sort was a
 * dropdown value ("recent", "updated", …) and its type filter a tab-like
 * choice; neither has a v2 equivalent, so both start fresh.
 */
export function migrateFilesLibraryPrefs(state: unknown, version: number): Persisted {
  const base: Persisted = {
    viewMode: "grid",
    sort: null,
    projectScope: "current",
    sidebarWidthPx: FILES_SIDEBAR_DEFAULT_PX,
    expandedFolderIds: [],
    templatesCollapsed: false,
  }
  if (!state || typeof state !== "object") return base
  if (version < 2) {
    const v1 = state as PersistedV1
    return {
      ...base,
      ...(v1.viewMode === "grid" || v1.viewMode === "list" ? { viewMode: v1.viewMode } : {}),
      ...(v1.projectScope === "current" || v1.projectScope === "all"
        ? { projectScope: v1.projectScope }
        : {}),
    }
  }
  return { ...base, ...(state as Partial<Persisted>) }
}

export const useFilesLibraryStore = create<FilesLibraryState>()(
  persist(
    (set) => ({
      viewMode: "grid",
      sort: null,
      projectScope: "current",
      sidebarWidthPx: FILES_SIDEBAR_DEFAULT_PX,
      expandedFolderIds: [],
      templatesCollapsed: false,

      section: DEFAULT_FILES_SECTION,
      lens: DEFAULT_FILES_LENS,
      search: "",
      filters: DEFAULT_FILES_VIEW_FILTERS,
      selectedKey: null,
      moveTarget: null,
      renameTarget: null,
      deleteForeverTarget: null,
      emptyTrashOpen: false,
      folderDialog: null,
      deleteFolderTarget: null,
      saveTemplateTarget: null,
      shareTarget: null,

      setViewMode: (viewMode) => set({ viewMode }),
      setSort: (sort) => set({ sort }),
      setProjectScope: (projectScope) => set({ projectScope }),
      setSidebarWidth: (px) => set({ sidebarWidthPx: clampSidebar(px) }),
      setFolderExpanded: (folderId, expanded) =>
        set((state) => {
          const open = state.expandedFolderIds.includes(folderId)
          if (open === expanded) return state
          return {
            expandedFolderIds: expanded
              ? [...state.expandedFolderIds, folderId]
              : state.expandedFolderIds.filter((id) => id !== folderId),
          }
        }),
      setTemplatesCollapsed: (templatesCollapsed) => set({ templatesCollapsed }),
      setSection: (section) => set({ section, selectedKey: null }),
      setLens: (lens) => set({ lens }),
      setSearch: (search) => set({ search }),
      setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
      resetFilters: () => set({ filters: DEFAULT_FILES_VIEW_FILTERS, search: "" }),
      select: (selectedKey) => set({ selectedKey }),
      openMove: (keys) => set({ moveTarget: keys }),
      closeMove: () => set({ moveTarget: null }),
      openRename: (renameTarget) => set({ renameTarget }),
      closeRename: () => set({ renameTarget: null }),
      openDeleteForever: (keys) => set({ deleteForeverTarget: keys }),
      closeDeleteForever: () => set({ deleteForeverTarget: null }),
      setEmptyTrashOpen: (emptyTrashOpen) => set({ emptyTrashOpen }),
      openFolderDialog: (folderDialog) => set({ folderDialog }),
      closeFolderDialog: () => set({ folderDialog: null }),
      openDeleteFolder: (deleteFolderTarget) => set({ deleteFolderTarget }),
      closeDeleteFolder: () => set({ deleteFolderTarget: null }),
      openSaveTemplate: (saveTemplateTarget) => set({ saveTemplateTarget }),
      closeSaveTemplate: () => set({ saveTemplateTarget: null }),
      openShare: (keys) => set({ shareTarget: keys }),
      closeShare: () => set({ shareTarget: null }),
    }),
    {
      name: "files-library-prefs",
      version: 2,
      storage: persistLocalStorage(),
      migrate: migrateFilesLibraryPrefs,
      partialize: (s): Persisted => ({
        viewMode: s.viewMode,
        sort: s.sort,
        projectScope: s.projectScope,
        sidebarWidthPx: s.sidebarWidthPx,
        expandedFolderIds: s.expandedFolderIds,
        templatesCollapsed: s.templatesCollapsed,
      }),
    }
  )
)
