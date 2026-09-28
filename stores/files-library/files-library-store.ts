// View state of the Files page (ADR-0200). Layout, sort, type filter and
// workspace scope persist per device; the tab, folder, search text, preview
// selection and dialog targets are session state. The items themselves live
// in Dexie and the artifact store — this store holds only UI intent.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { ROOT_LIBRARY_FOLDER_ID } from "@/lib/db/files-library-types"
import type {
  FilesProjectScope,
  FilesSort,
  FilesTab,
  FilesTypeFilter,
} from "@/lib/files-library/types"
import { persistLocalStorage } from "@/stores/persist-storage"

export type FilesViewMode = "grid" | "list"

/** A folder dialog: create under `parentId`, or rename `folderId`. */
export type FilesFolderDialog =
  { mode: "create"; parentId: string } | { mode: "rename"; folderId: string; name: string } | null

interface FilesLibraryState {
  // Persisted preferences
  viewMode: FilesViewMode
  sort: FilesSort
  type: FilesTypeFilter
  projectScope: FilesProjectScope

  // Session state
  tab: FilesTab
  folderId: string
  search: string
  /** Entry key shown in the preview pane. */
  selectedKey: string | null
  /** Entry keys the move-to-folder dialog acts on. */
  moveTarget: string[] | null
  /** Entry key the delete confirmation acts on (Files-owned uploads only). */
  deleteTarget: string | null
  folderDialog: FilesFolderDialog
  /** Folder id the delete-folder confirmation acts on. */
  deleteFolderTarget: string | null

  setViewMode: (mode: FilesViewMode) => void
  setSort: (sort: FilesSort) => void
  setType: (type: FilesTypeFilter) => void
  setProjectScope: (scope: FilesProjectScope) => void
  /** Switching tab closes the preview and returns the Folders tab to its root. */
  setTab: (tab: FilesTab) => void
  enterFolder: (folderId: string) => void
  setSearch: (search: string) => void
  select: (key: string | null) => void
  openMove: (keys: string[]) => void
  closeMove: () => void
  openDelete: (key: string) => void
  closeDelete: () => void
  openFolderDialog: (dialog: Exclude<FilesFolderDialog, null>) => void
  closeFolderDialog: () => void
  openDeleteFolder: (folderId: string) => void
  closeDeleteFolder: () => void
}

export const useFilesLibraryStore = create<FilesLibraryState>()(
  persist(
    (set) => ({
      viewMode: "grid",
      sort: "recent",
      type: "all",
      projectScope: "current",

      tab: "recent",
      folderId: ROOT_LIBRARY_FOLDER_ID,
      search: "",
      selectedKey: null,
      moveTarget: null,
      deleteTarget: null,
      folderDialog: null,
      deleteFolderTarget: null,

      setViewMode: (viewMode) => set({ viewMode }),
      setSort: (sort) => set({ sort }),
      setType: (type) => set({ type }),
      setProjectScope: (projectScope) => set({ projectScope }),
      setTab: (tab) => set({ tab, folderId: ROOT_LIBRARY_FOLDER_ID, selectedKey: null }),
      enterFolder: (folderId) => set({ tab: "folders", folderId, selectedKey: null }),
      setSearch: (search) => set({ search }),
      select: (selectedKey) => set({ selectedKey }),
      openMove: (keys) => set({ moveTarget: keys }),
      closeMove: () => set({ moveTarget: null }),
      openDelete: (key) => set({ deleteTarget: key }),
      closeDelete: () => set({ deleteTarget: null }),
      openFolderDialog: (folderDialog) => set({ folderDialog }),
      closeFolderDialog: () => set({ folderDialog: null }),
      openDeleteFolder: (deleteFolderTarget) => set({ deleteFolderTarget }),
      closeDeleteFolder: () => set({ deleteFolderTarget: null }),
    }),
    {
      name: "files-library-prefs",
      version: 1,
      storage: persistLocalStorage(),
      partialize: (s) => ({
        viewMode: s.viewMode,
        sort: s.sort,
        type: s.type,
        projectScope: s.projectScope,
      }),
    }
  )
)
