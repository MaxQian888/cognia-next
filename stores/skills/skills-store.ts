// Zustand store for in-memory Skill panel state — filters, batch selection,
// active tab, current detail target. The persistent skill rows live in
// IndexedDB (Dexie); this store only holds ephemeral UI state and shouldn't
// be persisted to localStorage.

import { create } from "zustand"
import type { SkillCategory, SkillSource, SkillStatus } from "@/lib/claude/types"
import type { MonacoLanguage } from "@/components/skills/editor/language-from-path"

export interface EditorFile {
  /** "main" for SKILL.md, otherwise the resource id. */
  id: string
  kind: "main" | "resource"
  /** When kind === "resource", the SkillResource id. */
  resourceId?: string
  /** Display path used as the tab label (SKILL.md or scripts/x.sh). */
  path: string
  language: MonacoLanguage
  draftContent: string
  savedContent: string
}

export interface EditorWorkspace {
  activeSkillId: string | null
  openFiles: EditorFile[]
  activeFileId: string | null
  rightPaneOpen: boolean
}

const DEFAULT_WORKSPACE: EditorWorkspace = {
  activeSkillId: null,
  openFiles: [],
  activeFileId: null,
  rightPaneOpen: true,
}

export type SkillPanelTab = "my-skills" | "browse" | "editor" | "analytics"

export type SkillSortMode = "name" | "updated" | "usage"

export interface SkillFilters {
  query: string
  category: SkillCategory | "all"
  source: SkillSource | "all"
  status: SkillStatus | "all"
  tag: string | null
  sort: SkillSortMode
}

interface SkillsStoreState {
  activeTab: SkillPanelTab
  filters: SkillFilters
  /** Set of selected skill ids for batch operations. */
  selection: Set<string>
  /** When non-null, show the detail panel for this skill. */
  detailSkillId: string | null
  /** When true, the right-hand filter sheet is open. */
  filterSheetOpen: boolean
  /** When true, the mobile-only category navigator sheet is open. */
  categorySheetOpen: boolean
  /** When non-null, show the editor pre-filled with this skill (or empty when "create"). */
  editorTarget: { mode: "create" } | { mode: "edit"; skillId: string } | null
  /** When non-null, show the import dialog with these draft entries staged. */
  importStaging: ImportStaging | null
  /** When non-null, show the delete confirmation. */
  deleteTarget: { skillId: string; name: string } | null
  /** VSCode-style workspace state for the Editor tab. UI-only, not persisted. */
  editorWorkspace: EditorWorkspace

  setActiveTab: (tab: SkillPanelTab) => void
  setFilters: (patch: Partial<SkillFilters>) => void
  resetFilters: () => void
  setQuery: (query: string) => void
  toggleSelection: (id: string) => void
  selectAll: (ids: string[]) => void
  clearSelection: () => void
  openDetail: (skillId: string) => void
  closeDetail: () => void
  setFilterSheetOpen: (open: boolean) => void
  setCategorySheetOpen: (open: boolean) => void
  openCreate: () => void
  openEdit: (skillId: string) => void
  closeEditor: () => void
  setImportStaging: (staging: ImportStaging | null) => void
  setDeleteTarget: (target: { skillId: string; name: string } | null) => void
  openSkillInEditor: (skillId: string, mainContent: string) => void
  openFile: (file: EditorFile) => void
  closeFile: (id: string, force?: boolean) => void
  setActiveFile: (id: string) => void
  updateDraftContent: (id: string, content: string) => void
  markSaved: (id: string, savedContent: string) => void
  discardDrafts: () => void
  toggleRightPane: () => void
}

export interface ImportStaging {
  drafts: Array<{
    name: string
    description?: string
    content: string
    tags?: string[]
    allowedTools?: string[]
    category?: SkillCategory
  }>
  /** Per-source label (e.g., "Markdown files (3)" or "~/.claude/skills/"). */
  sourceLabel: string
  /** Files that couldn't be parsed; surfaced in the dialog summary. */
  parseErrors: { name: string; error: string }[]
}

const DEFAULT_FILTERS: SkillFilters = {
  query: "",
  category: "all",
  source: "all",
  status: "all",
  tag: null,
  sort: "name",
}

export const useSkillsStore = create<SkillsStoreState>((set, _get) => ({
  activeTab: "my-skills",
  filters: DEFAULT_FILTERS,
  selection: new Set<string>(),
  detailSkillId: null,
  filterSheetOpen: false,
  categorySheetOpen: false,
  editorTarget: null,
  importStaging: null,
  deleteTarget: null,
  editorWorkspace: DEFAULT_WORKSPACE,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  setQuery: (query) => set((s) => ({ filters: { ...s.filters, query } })),
  toggleSelection: (id) =>
    set((s) => {
      const next = new Set(s.selection)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selection: next }
    }),
  selectAll: (ids) => set({ selection: new Set(ids) }),
  clearSelection: () => set({ selection: new Set() }),
  openDetail: (skillId) => set({ detailSkillId: skillId }),
  closeDetail: () => set({ detailSkillId: null }),
  setFilterSheetOpen: (open) => set({ filterSheetOpen: open }),
  setCategorySheetOpen: (open) => set({ categorySheetOpen: open }),
  openCreate: () => set({ editorTarget: { mode: "create" }, detailSkillId: null }),
  openEdit: (skillId) => set({ editorTarget: { mode: "edit", skillId }, detailSkillId: null }),
  closeEditor: () => set({ editorTarget: null }),
  setImportStaging: (staging) => set({ importStaging: staging }),
  setDeleteTarget: (target) => set({ deleteTarget: target }),

  openSkillInEditor: (skillId, mainContent) =>
    set({
      editorWorkspace: {
        activeSkillId: skillId,
        openFiles: [
          {
            id: "main",
            kind: "main",
            path: "SKILL.md",
            language: "markdown",
            draftContent: mainContent,
            savedContent: mainContent,
          },
        ],
        activeFileId: "main",
        rightPaneOpen: true,
      },
    }),

  openFile: (file) =>
    set((s) => {
      const idx = s.editorWorkspace.openFiles.findIndex((f) => f.id === file.id)
      const openFiles =
        idx >= 0 ? s.editorWorkspace.openFiles : [...s.editorWorkspace.openFiles, file]
      return {
        editorWorkspace: { ...s.editorWorkspace, openFiles, activeFileId: file.id },
      }
    }),

  closeFile: (id, _force) =>
    set((s) => {
      const openFiles = s.editorWorkspace.openFiles.filter((f) => f.id !== id)
      const activeFileId =
        s.editorWorkspace.activeFileId === id
          ? (openFiles[openFiles.length - 1]?.id ?? null)
          : s.editorWorkspace.activeFileId
      return { editorWorkspace: { ...s.editorWorkspace, openFiles, activeFileId } }
    }),

  setActiveFile: (id) =>
    set((s) => ({ editorWorkspace: { ...s.editorWorkspace, activeFileId: id } })),

  updateDraftContent: (id, content) =>
    set((s) => ({
      editorWorkspace: {
        ...s.editorWorkspace,
        openFiles: s.editorWorkspace.openFiles.map((f) =>
          f.id === id ? { ...f, draftContent: content } : f
        ),
      },
    })),

  markSaved: (id, savedContent) =>
    set((s) => ({
      editorWorkspace: {
        ...s.editorWorkspace,
        openFiles: s.editorWorkspace.openFiles.map((f) =>
          f.id === id ? { ...f, savedContent } : f
        ),
      },
    })),

  discardDrafts: () =>
    set((s) => ({
      editorWorkspace: {
        ...s.editorWorkspace,
        openFiles: s.editorWorkspace.openFiles.map((f) => ({
          ...f,
          draftContent: f.savedContent,
        })),
      },
    })),

  toggleRightPane: () =>
    set((s) => ({
      editorWorkspace: { ...s.editorWorkspace, rightPaneOpen: !s.editorWorkspace.rightPaneOpen },
    })),
}))
