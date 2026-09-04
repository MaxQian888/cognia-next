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
// Section model:
//   * `activeSection` drives the 3-pane shell's left nav. Legacy `?tab=`
//     deep links are translated to the section vocabulary by a one-time
//     redirect in `plugin-panel.tsx` — the store has no `activeTab` concept.
//   * `librarySubFilter` is the single source of truth for the
//     status/has-update/configurable filter dimensions: setting it mutates
//     `filters.status` / `filters.hasUpdate` / `filters.configurable` so the
//     existing filter pipeline keeps working without a parallel code path.
//     The filter sheet owns the orthogonal dimensions only (capability /
//     permission / source / signed-only / sort).
//   * `governanceView` picks between the cross-plugin aggregate views.
//   * `detailSubTab` is the expanded right-pane section when a plugin is
//     selected. `openConfigure(pluginId)` opens the detail pane on the
//     Configure section.
//   * `listViewMode` is the only persisted field (localStorage).

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"

// `agent-packages` is the Pi package manager (ADR-0119). It is a section of
// /plugins rather than a page of its own because it answers the same question
// as the rest of the panel — "what extends my agent, and what does it cost?" —
// only for a different runtime's package system.
export type PluginNavSection = "library" | "discover" | "agent-packages" | "governance" | "devtools"

export type PluginLibrarySubFilter = "all" | "enabled" | "updates" | "configurable" | "errored"

export type PluginGovernanceView = "permissions" | "scheduled" | "analytics" | "audit" | "policy"

/**
 * The expandable sections of the detail pane, and only those.
 *
 * No `"logs"`: that entry navigates to `/logs` rather than expanding in place
 * (`plugin-detail-pane.tsx`), so there is no section for this value to open.
 * Leaving it in the union advertised a state that renders every section
 * collapsed with nothing saying why.
 */
export type PluginDetailSubTab = "overview" | "capabilities" | "configure" | "permissions" | "data"

export type PluginListViewMode = "list" | "card"

export type PluginSortMode = "name" | "updated" | "usage" | "rating"

export type PluginCapabilityFilter = string | "all"
export type PluginPermissionFilter = string | "all"
export type PluginSourceFilter = string | "all"

/**
 * Discover's two axes, which used to be one.
 *
 * The marketplace shipped a single eight-item ToggleGroup that mixed curation
 * (all / featured / popular / recent) with origin (builtin / workspace /
 * shared / vscode). Two orthogonal questions on one control means "featured
 * extensions from Open VSX" cannot be asked at all, and picking a registry
 * silently discards whatever curation the user had chosen.
 *
 * Curation is applied as a membership filter over whatever the origin
 * returned, so the two compose as AND. `curationAnswerableBy` says which
 * origins can answer a curation at all: featured / popular / recent are
 * rankings the cognia registry publishes, and no other source has them.
 */
export type PluginDiscoverCuration = "all" | "featured" | "popular" | "recent"
export type PluginDiscoverOrigin = "all" | "registry" | "builtin" | "workspace" | "vscode"

export function curationAnswerableBy(origin: PluginDiscoverOrigin): boolean {
  return origin === "all" || origin === "registry"
}
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
  /** Top-level nav section in the 3-pane shell. */
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
  /** Discover's curation axis (which ranking), independent of the origin. */
  discoverCuration: PluginDiscoverCuration
  /** Discover's origin axis (which registry or catalog). */
  discoverOrigin: PluginDiscoverOrigin

  setActiveSection: (section: PluginNavSection) => void
  setDiscoverCuration: (curation: PluginDiscoverCuration) => void
  /**
   * Also resets the curation when the new origin cannot answer one, so the
   * control never shows a ranking the visible list is not filtered by.
   */
  setDiscoverOrigin: (origin: PluginDiscoverOrigin) => void
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
  /** Open the detail pane on this plugin's Configure section. */
  openConfigure: (pluginId: string) => void
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
 * Mutate the filters slice so the existing `usePlugins()` filter pipeline
 * keeps interpreting the sub-filter without a parallel code path. This is the
 * single writer of the status / has-update / configurable dimensions.
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
      activeSection: "library",
      librarySubFilter: "all",
      governanceView: "permissions",
      detailSubTab: "overview",
      listViewMode: "list",
      filters: DEFAULT_PLUGIN_FILTERS,
      selection: new Set<string>(),
      detailPluginId: null,
      discoverCuration: "all",
      discoverOrigin: "all",
      filterSheetOpen: false,
      importStaging: null,
      deleteTarget: null,
      deleteQueue: [],
      permissionReviewTarget: null,
      conflictDialogTarget: null,
      rollbackTarget: null,

      setActiveSection: (section) => set({ activeSection: section }),
      setLibrarySubFilter: (sub) =>
        set((s) => ({
          librarySubFilter: sub,
          filters: applyLibrarySubFilterToFilters(sub, s.filters),
        })),
      setGovernanceView: (view) => set({ governanceView: view }),
      setDetailSubTab: (sub) => set({ detailSubTab: sub }),
      setDiscoverCuration: (curation) => set({ discoverCuration: curation }),
      setDiscoverOrigin: (origin) =>
        set((state) => ({
          discoverOrigin: origin,
          discoverCuration: curationAnswerableBy(origin) ? state.discoverCuration : "all",
        })),
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
      // Opening Configure drives the detail pane onto its Configure section.
      openConfigure: (pluginId) =>
        set({
          detailPluginId: pluginId,
          detailSubTab: "configure",
          activeSection: "library",
        }),
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
      storage: persistLocalStorage(),
      // Only `listViewMode` survives reloads. Everything else is ephemeral UI
      // state and should reset every session.
      partialize: (s) => ({ listViewMode: s.listViewMode }),
    }
  )
)
