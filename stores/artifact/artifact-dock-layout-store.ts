/**
 * Artifact Dock Layout Store — persisted shell sizing for the docked artifacts
 * panel that lives alongside the chat workspace (Codex / Claude-artifacts style).
 *
 * Owns: the dock width (percent), collapsed flag, the history-rail open flag,
 * and a runtime-only mobile-sheet open flag. `<ArtifactWorkspaceDock />` calls
 * `setDockSize` on every drag tick; persistence is debounced internally so
 * localStorage isn't thrashed.
 *
 * Mirrors `stores/canvas/canvas-layout-store.ts` — the artifact data lives in
 * `artifact-store.ts` (persisted v3, widely imported); this keeps the UI layout
 * concern separate so that store's careful partialize/migrate stays untouched.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

export const ARTIFACT_DOCK_BOUNDS = {
  min: 24,
  max: 50,
  default: 34,
} as const

export const ARTIFACT_DOCK_PERSIST_DEBOUNCE_MS = 150

export interface ArtifactDockLayoutState {
  /** Dock width as a percentage of the chat workspace. */
  dockSize: number
  /** When true the dock is hidden (collapsedSize 0). Default: hidden until an artifact opens. */
  dockCollapsed: boolean
  /** When true the in-dock artifact history rail is shown beside the panel. */
  listRailOpen: boolean
  /** Runtime-only: the mobile/tablet Sheet fallback open state (NOT persisted). */
  mobileSheetOpen: boolean
  /** Bumped on migrate / reset so ResizablePanelGroup remounts with new defaults. */
  layoutVersion: number

  setDockSize: (pct: number) => void
  toggleDock: () => void
  setDockCollapsed: (collapsed: boolean) => void
  toggleListRail: () => void
  setListRailOpen: (open: boolean) => void
  setMobileSheetOpen: (open: boolean) => void
  resetLayout: () => void
}

interface PersistedArtifactDockLayoutState {
  dockSize: number
  dockCollapsed: boolean
  listRailOpen: boolean
  layoutVersion: number
}

const DEFAULTS = {
  dockSize: ARTIFACT_DOCK_BOUNDS.default,
  dockCollapsed: true,
  listRailOpen: false,
  layoutVersion: 0,
}

// Module-level debounce token shared across calls. Each `setDockSize` applies
// the clamped value immediately (so the UI tracks the drag) and schedules a
// single delayed `setState` that nudges the persist middleware to flush once
// after the drag settles.
let pendingFlush: ReturnType<typeof setTimeout> | null = null

function clampDockSize(value: number): number {
  if (!Number.isFinite(value)) return ARTIFACT_DOCK_BOUNDS.default
  return Math.max(ARTIFACT_DOCK_BOUNDS.min, Math.min(ARTIFACT_DOCK_BOUNDS.max, value))
}

export const useArtifactDockLayoutStore = create<ArtifactDockLayoutState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      mobileSheetOpen: false,

      setDockSize: (pct) => {
        set({ dockSize: clampDockSize(pct) })
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = setTimeout(() => {
          pendingFlush = null
          // Touch state again so the persist middleware writes the settled
          // value exactly once after the drag stops.
          set({ dockSize: get().dockSize })
        }, ARTIFACT_DOCK_PERSIST_DEBOUNCE_MS)
      },

      toggleDock: () => set((state) => ({ dockCollapsed: !state.dockCollapsed })),
      setDockCollapsed: (collapsed) => set({ dockCollapsed: collapsed }),
      toggleListRail: () => set((state) => ({ listRailOpen: !state.listRailOpen })),
      setListRailOpen: (open) => set({ listRailOpen: open }),
      setMobileSheetOpen: (open) => set({ mobileSheetOpen: open }),
      resetLayout: () =>
        set((state) => ({
          ...DEFAULTS,
          layoutVersion: state.layoutVersion + 1,
          mobileSheetOpen: false,
        })),
    }),
    {
      name: "cognia-artifact-dock-layout",
      version: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- subset persistence
      partialize: (state): any => ({
        dockSize: state.dockSize,
        dockCollapsed: state.dockCollapsed,
        listRailOpen: state.listRailOpen,
        layoutVersion: state.layoutVersion,
      }),
      merge: (persisted: unknown, current: ArtifactDockLayoutState) => {
        const p = (persisted ?? {}) as Partial<PersistedArtifactDockLayoutState>
        return {
          ...current,
          ...p,
          dockSize: clampDockSize(p.dockSize ?? current.dockSize),
          // mobileSheetOpen is runtime-only — never restore it from disk.
          mobileSheetOpen: false,
        } as ArtifactDockLayoutState
      },
    }
  )
)

export default useArtifactDockLayoutStore
