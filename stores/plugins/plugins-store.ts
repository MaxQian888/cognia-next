// Zustand store for in-memory Plugin panel state — filters, batch selection,
// nav section, sub-filters, detail sub-tab, list/card view mode, current
// detail / configure / permission-review / conflict targets. Persistent
// plugin rows live in IndexedDB (Dexie); only `listViewMode` is persisted to
// localStorage via the `persist` middleware (the rest stays ephemeral).
//
// Mirror of `stores/skills/skills-store.ts` with plugin-specific enums and
// dialog targets:
//   * "configure" tab is plugin-specific — drives the manifest.configSchema
//     form (no skill equivalent).
//   * "permissions" / "scheduled" / "devtools" tabs surface plugin platform
//     features that don't apply to skills.
//   * permissionReviewTarget / conflictDialogTarget are dialog hosts that the
//     skills panel doesn't need.
//
// Section model (post-redesign, ADR-pending plugin-panel-restructure):
//   * `activeSection` drives the 3-pane shell's left nav. The legacy
//     `activeTab` field is kept as a back-compat shim so `?tab=...` deep
//     links and the existing Settings overview keep working through one
//     release cycle — `setActiveTab` mirrors into `activeSection` and the
//     library sub-filter.
//   * `librarySubFilter` is sugar over `filters`: setting it also mutates
//     `filters.status` and `filters.hasUpdate` so the existing filter
//     pipeline keeps working without a parallel code path.
//   * `governanceView` picks between the four cross-plugin aggregate views.
//   * `detailSubTab` is the active right-pane sub-tab when a plugin is
//     selected. `openConfigure(pluginId)` now opens the detail pane on the
//     Configure sub-tab instead of clearing detailPluginId — the legacy
//     configTarget host is still set for any external surfaces that key off
//     it.
//   * `listViewMode` is the only persisted field (localStorage).

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"

export type PluginPanelTab =
  | "installed"
  | "browse"
  | "configure"
  | "permissions"
  | "scheduled"
  | "analytics"
  | "devtools"

export type PluginNavSection = "library" | "discover" | "governance" | "devtools"

export type PluginLibrarySubFilter = "all" | "enabled" | "updates" | "configurable" | "errored"

export type PluginGovernanceView = "permissions" | "scheduled" | "analytics" | "audit"

export type PluginDetailSubTab =
  | "overview"
  | "capabilities"
  | "configure"
  | "permissions"
  | "data"
  | "logs"

export type PluginListViewMode = "list" | "card"

export type PluginSortMode = "name" | "updated" | "usage" | "rating"

export type PluginCapabilityFilter = string | "all"
export type PluginPermissionFilter = string | "all"
export type PluginSourceFilter = string | "all"
export type PluginStatusFilter = string | "all"

export interface PluginFilters {
  query: string
  capability: PluginCapabilityFilter
  permission: PluginPermissionFilter
  source: PluginSourceFilter
  status: PluginStatusFilter
  tag: string | null
  sort: PluginSortMode
  /** Show only plugins with verified publisher signatures. */
  signedOnly: boolean
  /** Show only plugins that have a marketplace update available. */
  hasUpdate: boolean
  /**
   * "Configurable" library sub-filter — keep only plugins whose manifest
   * carries a `configSchema`. Behaviour lives in `usePlugins.applyFilters`;
   * the library sub-filter setter is the only writer.
   */
  configurable: boolean
}

export interface PluginImportStaging {
  /** Free-form drafts staged before a final install confirm. */
  drafts: Array<{
    id: string
    name: string
    version: string
    manifest: Record<string, unknown>
    /** Raw bundle path or URL the entry came from. */
    sourceLabel: string
  }>
  /** Aggregate label shown in the dialog header. */
  sourceLabel: string
  /** Manifest validation failures surfaced as a warning list. */
  parseErrors: { name: string; error: string }[]
}

export interface ConflictSummary {
  pluginId: string
  /** Free-form list — the resolved-conflict shape lives in lib/plugin/package. */
  conflicts: Array<{
    severity: "high" | "medium" | "low"
    message: string
    relatedPluginId?: string
  }>
}

interface PluginsStoreState {
  /**
   * Legacy 7-tab field. Kept as a back-compat shim — `setActiveTab` mirrors
   * the value into `activeSection` + `governanceView` + `librarySubFilter`
   * so old `?tab=...` deep links keep working.
   */
  activeTab: PluginPanelTab
  /** Top-level nav section in the new 3-pane shell. */
  activeSection: PluginNavSection
  /** Library sub-filter — also mutates `filters.status` / `filters.hasUpdate`. */
  librarySubFilter: PluginLibrarySubFilter
  /** Which cross-plugin aggregate view is active under Governance. */
  governanceView: PluginGovernanceView
  /** Active right-pane sub-tab when a plugin is selected. */
  detailSubTab: PluginDetailSubTab
  /** Compact list vs card grid — persisted to localStorage. */
  listViewMode: PluginListViewMode
  filters: PluginFilters
  /** Set of selected plugin ids for batch operations. */
  selection: Set<string>
  /** When non-null, show the detail panel for this plugin. */
  detailPluginId: string | null
  /** When true, the right-hand filter sheet is open. */
  filterSheetOpen: boolean
  /** When non-null, surface the manifest.configSchema form for this plugin. */
  configTarget: { pluginId: string } | null
  /** When non-null, show the import dialog with these draft entries staged. */
  importStaging: PluginImportStaging | null
  /** When non-null, show the delete confirmation. */
  deleteTarget: { pluginId: string; name: string } | null
  /**
   * FIFO of pending deletes from a batch-uninstall. The dialog host pops the
   * head into `deleteTarget` on every cancel/confirm so the user walks the
   * full selection without re-triggering the batch action manually.
   */
  deleteQueue: { pluginId: string; name: string }[]
  /** When non-null, render the permission-review dialog for this plugin. */
  permissionReviewTarget: { pluginId: string } | null
  /** When non-null, show the conflict dialog before completing an install. */
  conflictDialogTarget: ConflictSummary | null
  /** When non-null, open the rollback dialog scoped to this plugin id. */
  rollbackTarget: string | null

  setActiveTab: (tab: PluginPanelTab) => void
  setActiveSection: (section: PluginNavSection) => void
  setLibrarySubFilter: (sub: PluginLibrarySubFilter) => void
  setGovernanceView: (view: PluginGovernanceView) => void
  setDetailSubTab: (sub: PluginDetailSubTab) => void
  setListViewMode: (mode: PluginListViewMode) => void
  setFilters: (patch: Partial<PluginFilters>) => void
  resetFilters: () => void
  setQuery: (query: string) => void
  toggleSelection: (id: string) => void
  selectAll: (ids: string[]) => void
  clearSelection: () => void
  openDetail: (pluginId: string) => void
  closeDetail: () => void
  setFilterSheetOpen: (open: boolean) => void
  openConfigure: (pluginId: string) => void
  closeConfigure: () => void
  setImportStaging: (staging: PluginImportStaging | null) => void
  setDeleteTarget: (target: { pluginId: string; name: string } | null) => void
  /**
   * Queue a batch of plugins for sequential deletion. Sets the first entry
   * as the active `deleteTarget` and stores the remaining ones in
   * `deleteQueue`. Use `advanceDeleteQueue` after the user confirms or
   * cancels each dialog.
   */
  enqueueDeleteTargets: (targets: { pluginId: string; name: string }[]) => void
  /**
   * Pop the next queued delete into `deleteTarget`. Called by the dialog
   * host after both cancel and confirm so the bulk uninstall walks the
   * whole selection without losing entries.
   */
  advanceDeleteQueue: () => void
  /** Drop any pending batch deletes (used by clear-selection / bar dismiss). */
  clearDeleteQueue: () => void
  openPermissionReview: (pluginId: string) => void
  closePermissionReview: () => void
  setConflictDialogTarget: (target: ConflictSummary | null) => void
  setRollbackTarget: (pluginId: string | null) => void
}

export const DEFAULT_PLUGIN_FILTERS: PluginFilters = {
  query: "",
  capability: "all",
  permission: "all",
  source: "all",
  status: "all",
  tag: null,
  sort: "name",
  signedOnly: false,
  hasUpdate: false,
  configurable: false,
}

/**
 * Translate a legacy `?tab=` value into the equivalent new-shell state.
 * Used by `setActiveTab` and the URL sync effect in `plugin-panel.tsx`.
 */
export function deriveSectionFromTab(tab: PluginPanelTab): {
  section: PluginNavSection
  librarySub?: PluginLibrarySubFilter
  governance?: PluginGovernanceView
  detailSub?: PluginDetailSubTab
} {
  switch (tab) {
    case "installed":
      return { section: "library" }
    case "browse":
      return { section: "discover" }
    case "configure":
      return { section: "library", librarySub: "configurable", detailSub: "configure" }
    case "permissions":
      return { section: "governance", governance: "permissions" }
    case "scheduled":
      return { section: "governance", governance: "scheduled" }
    case "analytics":
      return { section: "governance", governance: "analytics" }
    case "devtools":
      return { section: "devtools" }
  }
}

/**
 * Mutate the filters slice so the existing `usePlugins()` filter pipeline
 * keeps interpreting the sub-filter without a parallel code path.
 */
function applyLibrarySubFilterToFilters(
  sub: PluginLibrarySubFilter,
  base: PluginFilters
): PluginFilters {
  switch (sub) {
    case "enabled":
      return { ...base, status: "enabled", hasUpdate: false, configurable: false }
    case "errored":
      // The Dexie `row.status` enum uses "error" — not "errored" — for the
      // failure state. The sub-filter name is a UX label, the filter value
      // maps to the underlying enum.
      return { ...base, status: "error", hasUpdate: false, configurable: false }
    case "updates":
      return { ...base, status: "all", hasUpdate: true, configurable: false }
    case "configurable":
      return { ...base, status: "all", hasUpdate: false, configurable: true }
    case "all":
    default:
      return { ...base, status: "all", hasUpdate: false, configurable: false }
  }
}

export const usePluginsStore = create<PluginsStoreState>()(
  persist(
    (set) => ({
      activeTab: "installed",
      activeSection: "library",
      librarySubFilter: "all",
      governanceView: "permissions",
      detailSubTab: "overview",
      listViewMode: "list",
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

      setActiveTab: (tab) =>
        set((s) => {
          const { section, librarySub, governance, detailSub } = deriveSectionFromTab(tab)
          const nextLibrarySub = librarySub ?? s.librarySubFilter
          return {
            activeTab: tab,
            activeSection: section,
            librarySubFilter: librarySub ?? s.librarySubFilter,
            governanceView: governance ?? s.governanceView,
            detailSubTab: detailSub ?? s.detailSubTab,
            filters: librarySub
              ? applyLibrarySubFilterToFilters(nextLibrarySub, s.filters)
              : s.filters,
          }
        }),
      setActiveSection: (section) => set({ activeSection: section }),
      setLibrarySubFilter: (sub) =>
        set((s) => ({
          librarySubFilter: sub,
          filters: applyLibrarySubFilterToFilters(sub, s.filters),
        })),
      setGovernanceView: (view) => set({ governanceView: view }),
      setDetailSubTab: (sub) => set({ detailSubTab: sub }),
      setListViewMode: (mode) => set({ listViewMode: mode }),
      setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
      resetFilters: () => set({ filters: DEFAULT_PLUGIN_FILTERS }),
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
      openDetail: (pluginId) => set({ detailPluginId: pluginId }),
      closeDetail: () => set({ detailPluginId: null }),
      setFilterSheetOpen: (open) => set({ filterSheetOpen: open }),
      // Opening Configure drives the detail pane onto its Configure sub-tab.
      // `configTarget` stays set so the modal `PluginConfigForm` host (still
      // mounted at the panel root) keeps surfacing the legacy configure
      // dialog for any external caller that triggers `openConfigure(...)`
      // without expecting the detail pane swap. The two paths coexist
      // cheaply — the modal opens on top of the detail pane, which is fine.
      openConfigure: (pluginId) =>
        set({
          configTarget: { pluginId },
          detailPluginId: pluginId,
          detailSubTab: "configure",
          activeSection: "library",
        }),
      closeConfigure: () => set({ configTarget: null }),
      setImportStaging: (staging) => set({ importStaging: staging }),
      setDeleteTarget: (target) => set({ deleteTarget: target }),
      enqueueDeleteTargets: (targets) =>
        set(() => {
          if (targets.length === 0) return { deleteTarget: null, deleteQueue: [] }
          const [head, ...rest] = targets
          return { deleteTarget: head, deleteQueue: rest }
        }),
      advanceDeleteQueue: () =>
        set((s) => {
          if (s.deleteQueue.length === 0) return { deleteTarget: null, deleteQueue: [] }
          const [next, ...rest] = s.deleteQueue
          return { deleteTarget: next, deleteQueue: rest }
        }),
      clearDeleteQueue: () => set({ deleteQueue: [] }),
      openPermissionReview: (pluginId) => set({ permissionReviewTarget: { pluginId } }),
      closePermissionReview: () => set({ permissionReviewTarget: null }),
      setConflictDialogTarget: (target) => set({ conflictDialogTarget: target }),
      setRollbackTarget: (pluginId) => set({ rollbackTarget: pluginId }),
    }),
    {
      name: "plugins-ui-prefs",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only `listViewMode` survives reloads. Everything else is ephemeral UI
      // state and should reset every session.
      partialize: (s) => ({ listViewMode: s.listViewMode }),
    }
  )
)
