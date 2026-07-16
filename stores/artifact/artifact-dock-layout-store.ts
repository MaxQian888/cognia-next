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

export type DockMode = "artifact" | "workspace"

type WorkspaceRevealFileRequest = {
  id: string
  sessionId: string
  rootPath: string
  kind: "file"
  relPath: string
}

type WorkspaceRevealReviewRequest = {
  id: string
  sessionId: string
  rootPath: string
  kind: "review"
}

export type WorkspaceRevealRequest = WorkspaceRevealFileRequest | WorkspaceRevealReviewRequest

export type WorkspaceDockContext =
  Omit<WorkspaceRevealFileRequest, "id"> | Omit<WorkspaceRevealReviewRequest, "id">

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
  /** Persisted desktop dock surface. */
  dockMode: DockMode
  /** Runtime-only reveal queue consumed after the workspace dock mounts. */
  workspaceRevealRequest: WorkspaceRevealRequest | null
  /** Runtime-only workspace target retained after a reveal request is consumed. */
  workspaceContext: WorkspaceDockContext | null
  /** Runtime-only: the mobile/tablet Sheet fallback open state (NOT persisted). */
  mobileSheetOpen: boolean
  /** Bumped on migrate / reset so ResizablePanelGroup remounts with new defaults. */
  layoutVersion: number

  setDockSize: (pct: number) => void
  toggleDock: () => void
  setDockCollapsed: (collapsed: boolean) => void
  toggleListRail: () => void
  setListRailOpen: (open: boolean) => void
  setDockMode: (mode: DockMode) => void
  revealWorkspaceFile: (request: { sessionId: string; rootPath: string; relPath: string }) => void
  revealWorkspaceReview: (request: { sessionId: string; rootPath: string }) => void
  clearWorkspaceRevealRequest: (id: string) => void
  clearWorkspaceContext: () => void
  setMobileSheetOpen: (open: boolean) => void
  resetLayout: () => void
}

interface PersistedArtifactDockLayoutState {
  dockSize: number
  dockCollapsed: boolean
  listRailOpen: boolean
  dockMode: DockMode
  layoutVersion: number
}

const DEFAULTS = {
  dockSize: ARTIFACT_DOCK_BOUNDS.default,
  dockCollapsed: true,
  listRailOpen: false,
  dockMode: "artifact" as DockMode,
  layoutVersion: 0,
}

let revealSequence = 0

function nextRevealId(): string {
  revealSequence += 1
  return `workspace-reveal-${revealSequence}`
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
      workspaceRevealRequest: null,
      workspaceContext: null,

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
      setDockMode: (dockMode) =>
        set({ dockMode, workspaceRevealRequest: null, workspaceContext: null }),
      revealWorkspaceFile: (request) =>
        set({
          dockMode: "workspace",
          dockCollapsed: false,
          workspaceContext: { kind: "file", ...request },
          workspaceRevealRequest: {
            id: nextRevealId(),
            kind: "file",
            ...request,
          },
        }),
      revealWorkspaceReview: (request) =>
        set({
          dockMode: "workspace",
          dockCollapsed: false,
          workspaceContext: { kind: "review", ...request },
          workspaceRevealRequest: {
            id: nextRevealId(),
            kind: "review",
            ...request,
          },
        }),
      clearWorkspaceRevealRequest: (id) =>
        set((state) =>
          state.workspaceRevealRequest?.id === id ? { workspaceRevealRequest: null } : state
        ),
      clearWorkspaceContext: () => set({ workspaceContext: null }),
      setMobileSheetOpen: (open) => set({ mobileSheetOpen: open }),
      resetLayout: () =>
        set((state) => ({
          ...DEFAULTS,
          layoutVersion: state.layoutVersion + 1,
          mobileSheetOpen: false,
          workspaceRevealRequest: null,
          workspaceContext: null,
        })),
    }),
    {
      name: "cognia-artifact-dock-layout",
      version: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- subset persistence
      partialize: (state): any => ({
        dockSize: state.dockSize,
        dockCollapsed: state.dockCollapsed,
        listRailOpen: state.listRailOpen,
        dockMode: state.dockMode,
        layoutVersion: state.layoutVersion,
      }),
      migrate: (persisted: unknown, version) => {
        const state = (persisted ?? {}) as Partial<PersistedArtifactDockLayoutState>
        if (version < 2) return { ...state, dockMode: "artifact" as DockMode }
        return state
      },
      merge: (persisted: unknown, current: ArtifactDockLayoutState) => {
        const p = (persisted ?? {}) as Partial<PersistedArtifactDockLayoutState>
        return {
          ...current,
          ...p,
          dockSize: clampDockSize(p.dockSize ?? current.dockSize),
          dockMode: p.dockMode === "workspace" ? "workspace" : "artifact",
          // mobileSheetOpen is runtime-only — never restore it from disk.
          mobileSheetOpen: false,
          workspaceRevealRequest: null,
          workspaceContext: null,
        } as ArtifactDockLayoutState
      },
    }
  )
)

export default useArtifactDockLayoutStore
