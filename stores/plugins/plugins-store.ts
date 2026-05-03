// Zustand store for in-memory Plugin panel state — filters, batch selection,
// active tab, current detail / configure / permission-review / conflict
// targets. Persistent plugin rows live in IndexedDB (Dexie); this store only
// holds ephemeral UI state and isn't persisted to localStorage.
//
// Mirror of `stores/skills/skills-store.ts` with plugin-specific enums and
// dialog targets:
//   * "configure" tab is plugin-specific — drives the manifest.configSchema
//     form (no skill equivalent).
//   * "permissions" / "scheduled" / "devtools" tabs surface plugin platform
//     features that don't apply to skills.
//   * permissionReviewTarget / conflictDialogTarget are dialog hosts that the
//     skills panel doesn't need.

import { create } from "zustand"

export type PluginPanelTab =
  | "installed"
  | "browse"
  | "configure"
  | "permissions"
  | "scheduled"
  | "analytics"
  | "devtools"

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
  activeTab: PluginPanelTab
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
  /** When non-null, render the permission-review dialog for this plugin. */
  permissionReviewTarget: { pluginId: string } | null
  /** When non-null, show the conflict dialog before completing an install. */
  conflictDialogTarget: ConflictSummary | null
  /** When non-null, open the rollback dialog scoped to this plugin id. */
  rollbackTarget: string | null

  setActiveTab: (tab: PluginPanelTab) => void
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
}

export const usePluginsStore = create<PluginsStoreState>((set) => ({
  activeTab: "installed",
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

  setActiveTab: (tab) => set({ activeTab: tab }),
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
  openConfigure: (pluginId) => set({ configTarget: { pluginId }, detailPluginId: null }),
  closeConfigure: () => set({ configTarget: null }),
  setImportStaging: (staging) => set({ importStaging: staging }),
  setDeleteTarget: (target) => set({ deleteTarget: target }),
  openPermissionReview: (pluginId) => set({ permissionReviewTarget: { pluginId } }),
  closePermissionReview: () => set({ permissionReviewTarget: null }),
  setConflictDialogTarget: (target) => set({ conflictDialogTarget: target }),
  setRollbackTarget: (pluginId) => set({ rollbackTarget: pluginId }),
}))
