// Zustand store for in-memory Skill panel state — filters, batch selection,
// active tab, current detail target. The persistent skill rows live in
// IndexedDB (Dexie); this store only holds ephemeral UI state and shouldn't
// be persisted to localStorage.

import { create } from "zustand"
import type {
  SkillCategory,
  SkillSource,
  SkillStatus,
  SkillValidationError,
} from "@cognia/agent-config-types"
import type { MonacoLanguage } from "@/components/skills/editor/language-from-path"
import type { SkillResourceDraft } from "@/lib/db/skill-resources"
import type { LastSkillView, SkillPanelPrefs } from "@/lib/skills/preferences"

export interface EditorFile {
  /** "main" for SKILL.md, "codex" for agents/openai.yaml, otherwise a resource id. */
  id: string
  kind: "main" | "codex" | "resource"
  /** When kind === "resource", the SkillResource id. */
  resourceId?: string
  /** Display path used as the tab label (SKILL.md or scripts/x.sh). */
  path: string
  language: MonacoLanguage
  draftContent: string
  savedContent: string
  /** Last persistence outcome; dirtiness remains derived from draft vs baseline. */
  saveState?: "clean" | "saving" | "saved" | "blocked" | "conflict" | "error"
  saveError?: string
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
  /**
   * When non-null, the create-skill Sheet is open. Existing skills are edited
   * in the workspace editor (Editor tab) — body in Monaco, metadata in its
   * "Skill settings" panel — so there is no separate edit-mode Sheet.
   */
  editorTarget: { mode: "create" } | null
  /**
   * Skill-shaped seed used to pre-fill the create editor (e.g. picked from a
   * template). Only read while `editorTarget.mode === "create"`; cleared when
   * the editor closes.
   */
  createSeed: import("@cognia/agent-config-types").Skill | null
  /** When non-null, show the import dialog with these draft entries staged. */
  importStaging: ImportStaging | null
  /** When non-null, show the delete confirmation. */
  deleteTarget: { skillId: string; name: string } | null
  /** When true, show the "Install from URL" dialog. */
  urlInstallOpen: boolean
  /**
   * skillId → "newer snapshot available" flags from the last explicit
   * "Check for updates" run. Shared so the toolbar (which runs the check),
   * the list rows, and the detail pane (which render badges/buttons) stay
   * in sync without prop-drilling.
   */
  updateAvailable: Record<string, boolean>
  /** VSCode-style workspace state for the Editor tab. UI-only, not persisted. */
  editorWorkspace: EditorWorkspace

  setActiveTab: (tab: SkillPanelTab) => void
  setFilters: (patch: Partial<SkillFilters>) => void
  resetFilters: () => void
  /**
   * Seed the ephemeral panel state from persisted preferences on mount:
   * default tab + sort + status filter. When `lastView` is provided
   * (`rememberLastView` on), restore the last tab and non-query filters
   * instead. Never persists — the caller owns write-back.
   */
  hydrateFromPrefs: (prefs: SkillPanelPrefs, lastView?: LastSkillView | null) => void
  setQuery: (query: string) => void
  toggleSelection: (id: string) => void
  selectAll: (ids: string[]) => void
  clearSelection: () => void
  openDetail: (skillId: string) => void
  closeDetail: () => void
  setFilterSheetOpen: (open: boolean) => void
  setCategorySheetOpen: (open: boolean) => void
  openCreate: (seed?: import("@cognia/agent-config-types").Skill) => void
  closeEditor: () => void
  setImportStaging: (staging: ImportStaging | null) => void
  setDeleteTarget: (target: { skillId: string; name: string } | null) => void
  setUrlInstallOpen: (open: boolean) => void
  setUpdateAvailable: (map: Record<string, boolean>) => void
  clearUpdateAvailable: (skillId: string) => void
  openSkillInEditor: (skillId: string, mainContent: string) => void
  openFile: (file: EditorFile) => void
  closeFile: (id: string, force?: boolean) => void
  setActiveFile: (id: string) => void
  updateDraftContent: (id: string, content: string) => void
  markSaved: (id: string, savedContent: string) => void
  markFileSaveState: (
    ids: string[],
    state: NonNullable<EditorFile["saveState"]>,
    error?: string
  ) => void
  discardDrafts: () => void
  toggleRightPane: () => void
}

export interface ImportStaging {
  drafts: Array<{
    name: string
    slug?: string
    description?: string
    compatibility?: string
    metadata?: Record<string, string>
    invocationPolicy?: "implicit" | "explicit"
    frontmatterExtensions?: Record<string, unknown>
    codexOpenAiYaml?: string
    content: string
    tags?: string[]
    allowedTools?: string[]
    category?: SkillCategory
    /**
     * Stable id used for upsert. Bundle imports derive this from the
     * frontmatter `name` plus the import flavor (`bundle:zip:<slug>` or
     * `bundle:folder:<slug>`); markdown / Claude Code imports leave it
     * undefined and fall back to name-based collision detection.
     */
    canonicalId?: string
    /**
     * Resources discovered in the bundle (scripts/, references/, assets/).
     * Persisted alongside the row via `replaceResourcesForSkill` after
     * the upsert.
     */
    resources?: Array<Omit<SkillResourceDraft, "skillId">>
    /** Non-fatal validation findings carried on the persisted row. */
    validationErrors?: SkillValidationError[]
    /**
     * Pre-assigned native directory (the source folder for folder imports,
     * or the cognia canonical path once materialized). Powers the
     * auto-push-to-disk flow in the SkillImportDialog success handler.
     */
    nativeDirectory?: string
  }>
  /** Per-source label (e.g., "Markdown files (3)" or "~/.claude/skills/"). */
  sourceLabel: string
  /** Files that couldn't be parsed; surfaced in the dialog summary. */
  parseErrors: { name: string; error: string }[]
  /** "anthropic" / "codex" for bundle imports — drives the flavor badge. */
  flavor?: "anthropic" | "codex"
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
  createSeed: null,
  importStaging: null,
  deleteTarget: null,
  urlInstallOpen: false,
  updateAvailable: {},
  editorWorkspace: DEFAULT_WORKSPACE,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  hydrateFromPrefs: (prefs, lastView) =>
    set((s) =>
      lastView
        ? {
            activeTab: lastView.tab,
            filters: {
              ...s.filters,
              sort: lastView.sort,
              category: lastView.category,
              source: lastView.source,
              status: lastView.status,
              tag: lastView.tag,
            },
          }
        : {
            activeTab: prefs.defaultTab,
            filters: {
              ...s.filters,
              sort: prefs.defaultSort,
              status: prefs.defaultStatusFilter,
            },
          }
    ),
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
  openCreate: (seed) =>
    set({ editorTarget: { mode: "create" }, createSeed: seed ?? null, detailSkillId: null }),
  closeEditor: () => set({ editorTarget: null, createSeed: null }),
  setImportStaging: (staging) => set({ importStaging: staging }),
  setDeleteTarget: (target) => set({ deleteTarget: target }),
  setUrlInstallOpen: (open) => set({ urlInstallOpen: open }),
  setUpdateAvailable: (map) => set({ updateAvailable: map }),
  clearUpdateAvailable: (skillId) =>
    set((s) => {
      if (!s.updateAvailable[skillId]) return s
      const next = { ...s.updateAvailable }
      delete next[skillId]
      return { updateAvailable: next }
    }),

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
            saveState: "clean",
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
          f.id === id
            ? { ...f, draftContent: content, saveState: "clean", saveError: undefined }
            : f
        ),
      },
    })),

  markSaved: (id, savedContent) =>
    set((s) => ({
      editorWorkspace: {
        ...s.editorWorkspace,
        openFiles: s.editorWorkspace.openFiles.map((f) =>
          f.id === id ? { ...f, savedContent, saveState: "saved", saveError: undefined } : f
        ),
      },
    })),

  markFileSaveState: (ids, saveState, saveError) => {
    const targets = new Set(ids)
    set((s) => ({
      editorWorkspace: {
        ...s.editorWorkspace,
        openFiles: s.editorWorkspace.openFiles.map((file) =>
          targets.has(file.id) ? { ...file, saveState, saveError } : file
        ),
      },
    }))
  },

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
