// Zustand store for in-memory MCP servers panel state — active tab, search,
// transport/status filters, batch selection, editor/delete targets, and the
// mobile filter-sheet toggle. The persistent server rows live in IndexedDB
// (`lib/db/mcp-servers.ts`); view preferences (grid/list, grouping, favorites)
// live on the `AppSettings` singleton (`hooks/mcp/use-mcp-panel-view.ts`).
//
// This is deliberately separate from `stores/mcp/mcp-store.ts`, which is a
// contract-compatible stub for the agent tool-picker. This store owns the
// settings-panel UI state and shouldn't be persisted to localStorage.

import { create } from "zustand"
import type { McpServer, McpTransport } from "@/lib/claude/types"

export type McpPanelTab = "my-servers" | "presets" | "agents" | "health"

export type McpTransportFilter = "all" | McpTransport
export type McpStatusFilter = "all" | "enabled" | "disabled"

/** The minimal server shape the editor seeds from (no id/timestamps). */
export type McpEditorSeed = Pick<
  McpServer,
  "name" | "transport" | "config" | "enabled" | "appsEnabled"
>

/**
 * "create" (optionally seeded — from a clone or a custom preset), or "edit" an
 * existing row by id.
 */
export type McpEditorTarget =
  | { mode: "create"; seed?: McpEditorSeed }
  | { mode: "edit"; serverId: string }
  | null

interface McpPanelStoreState {
  activeTab: McpPanelTab
  search: string
  transportFilter: McpTransportFilter
  statusFilter: McpStatusFilter
  /** Set of selected server ids for batch operations. */
  selection: Set<string>
  /** When non-null, the editor sheet is open for create/edit. */
  editorTarget: McpEditorTarget
  /** When non-null, show the delete confirmation. */
  deleteTarget: { serverId: string; name: string } | null
  /** Mobile-only right-hand filter sheet toggle. */
  filterSheetOpen: boolean

  setActiveTab: (tab: McpPanelTab) => void
  setSearch: (search: string) => void
  setTransportFilter: (filter: McpTransportFilter) => void
  setStatusFilter: (filter: McpStatusFilter) => void
  resetFilters: () => void
  toggleSelection: (id: string) => void
  selectAll: (ids: string[]) => void
  clearSelection: () => void
  openCreate: (seed?: McpEditorSeed) => void
  openEdit: (serverId: string) => void
  closeEditor: () => void
  setDeleteTarget: (target: { serverId: string; name: string } | null) => void
  setFilterSheetOpen: (open: boolean) => void
}

export const useMcpPanelStore = create<McpPanelStoreState>((set) => ({
  activeTab: "my-servers",
  search: "",
  transportFilter: "all",
  statusFilter: "all",
  selection: new Set<string>(),
  editorTarget: null,
  deleteTarget: null,
  filterSheetOpen: false,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setSearch: (search) => set({ search }),
  setTransportFilter: (transportFilter) => set({ transportFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  resetFilters: () => set({ search: "", transportFilter: "all", statusFilter: "all" }),
  toggleSelection: (id) =>
    set((s) => {
      const next = new Set(s.selection)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selection: next }
    }),
  selectAll: (ids) => set({ selection: new Set(ids) }),
  clearSelection: () => set({ selection: new Set() }),
  openCreate: (seed) => set({ editorTarget: { mode: "create", seed } }),
  openEdit: (serverId) => set({ editorTarget: { mode: "edit", serverId } }),
  closeEditor: () => set({ editorTarget: null }),
  setDeleteTarget: (deleteTarget) => set({ deleteTarget }),
  setFilterSheetOpen: (filterSheetOpen) => set({ filterSheetOpen }),
}))
