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

export type DockMode = "artifact" | "workspace" | "browser"

type WorkspaceRevealFileRequest = {
  id: string
  sessionId: string
  rootPath: string
  kind: "file"
  relPath: string
  line?: number
  column?: number
}

type WorkspaceRevealReviewRequest = {
  id: string
  sessionId: string
  rootPath: string
  kind: "review"
  relPath?: string
}

export type WorkspaceRevealRequest = WorkspaceRevealFileRequest | WorkspaceRevealReviewRequest

export type WorkspaceDockContext =
  Omit<WorkspaceRevealFileRequest, "id"> | Omit<WorkspaceRevealReviewRequest, "id">

export const ARTIFACT_DOCK_BOUNDS = {
  min: 24,
  max: 50,
  default: 34,
} as const

// Workspace mode needs more horizontal room than a simple artifact preview
// (file tree + Monaco + git diff), so it gets a wider cap and an absolute
// pixel floor — a percentage floor alone leaves it unusable on small laptops
// (24% of 1280px ≈ 307px). The px unit is native to react-resizable-panels.
export const WORKSPACE_DOCK_BOUNDS = {
  minPx: "480px",
  max: 65,
} as const

/** Chat (left) panel minimum, widened dock in workspace mode reclaims from it. */
export const CHAT_MIN_PERCENT = {
  default: 50,
  workspace: 35,
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
  /**
   * Runtime-only: true after the user manually collapsed the dock, so a fresh
   * artifact stops force-expanding it. Cleared whenever the user re-opens.
   */
  userDismissed: boolean
  /**
   * Runtime-only: a new artifact arrived while the user had the dock dismissed.
   * Surfaces as an unread dot on the chat-header dock toggle; cleared on open.
   */
  unreadArtifact: boolean
  /** Bumped on migrate / reset so ResizablePanelGroup remounts with new defaults. */
  layoutVersion: number

  setDockSize: (pct: number) => void
  toggleDock: () => void
  setDockCollapsed: (collapsed: boolean) => void
  /**
   * A new artifact became active. Expands the dock unless the user dismissed it
   * (then only flags it unread), so we never yank open a panel the user closed.
   */
  notifyNewArtifact: () => void
  toggleListRail: () => void
  setListRailOpen: (open: boolean) => void
  setDockMode: (mode: DockMode) => void
  /** Reveal the browser surface in the expanded chat right rail. */
  openBrowser: () => void
  revealWorkspaceFile: (request: {
    sessionId: string
    rootPath: string
    relPath: string
    line?: number
    column?: number
  }) => void
  revealWorkspaceReview: (request: {
    sessionId: string
    rootPath: string
    relPath?: string
  }) => void
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
  // Permissive window spanning both modes; the per-mode min/max on the
  // ResizablePanel does the real render-time enforcement. Keeping the stored
  // percent within [artifact.min, workspace.max] lets a wide workspace size
  // survive a reload without being clamped down to the artifact cap.
  return Math.max(ARTIFACT_DOCK_BOUNDS.min, Math.min(WORKSPACE_DOCK_BOUNDS.max, value))
}

export const useArtifactDockLayoutStore = create<ArtifactDockLayoutState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      mobileSheetOpen: false,
      userDismissed: false,
      unreadArtifact: false,
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

      toggleDock: () =>
        set((state) =>
          state.dockCollapsed
            ? { dockCollapsed: false, userDismissed: false, unreadArtifact: false }
            : { dockCollapsed: true, userDismissed: true }
        ),
      setDockCollapsed: (collapsed) =>
        set(
          collapsed
            ? { dockCollapsed: true, userDismissed: true }
            : { dockCollapsed: false, userDismissed: false, unreadArtifact: false }
        ),
      notifyNewArtifact: () =>
        set((state) =>
          state.userDismissed
            ? { unreadArtifact: true }
            : {
                dockMode: "artifact",
                dockCollapsed: false,
                userDismissed: false,
                unreadArtifact: false,
              }
        ),
      toggleListRail: () => set((state) => ({ listRailOpen: !state.listRailOpen })),
      setListRailOpen: (open) => set({ listRailOpen: open }),
      setDockMode: (dockMode) =>
        set({
          dockMode,
          unreadArtifact: false,
          workspaceRevealRequest: null,
          workspaceContext: null,
        }),
      openBrowser: () =>
        set({
          dockMode: "browser",
          dockCollapsed: false,
          userDismissed: false,
          unreadArtifact: false,
          mobileSheetOpen: false,
          workspaceRevealRequest: null,
          workspaceContext: null,
        }),
      revealWorkspaceFile: (request) =>
        set({
          dockMode: "workspace",
          dockCollapsed: false,
          userDismissed: false,
          unreadArtifact: false,
          mobileSheetOpen: true,
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
          userDismissed: false,
          unreadArtifact: false,
          mobileSheetOpen: true,
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
      setMobileSheetOpen: (open) =>
        set(
          open
            ? { mobileSheetOpen: true }
            : {
                mobileSheetOpen: false,
                workspaceRevealRequest: null,
                workspaceContext: null,
              }
        ),
      resetLayout: () =>
        set((state) => ({
          ...DEFAULTS,
          layoutVersion: state.layoutVersion + 1,
          mobileSheetOpen: false,
          userDismissed: false,
          unreadArtifact: false,
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
          dockMode:
            p.dockMode === "workspace" || p.dockMode === "browser" ? p.dockMode : "artifact",
          // mobileSheetOpen / userDismissed / unreadArtifact are runtime-only —
          // never restore them from disk.
          mobileSheetOpen: false,
          userDismissed: false,
          unreadArtifact: false,
          workspaceRevealRequest: null,
          workspaceContext: null,
        } as ArtifactDockLayoutState
      },
    }
  )
)

export default useArtifactDockLayoutStore
