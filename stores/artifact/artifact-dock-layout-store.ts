/**
 * Artifact Dock Layout Store — persisted shell sizing for the docked artifacts
 * panel that lives alongside the chat workspace (Codex / Claude-artifacts style).
 *
 * Owns the dock *shell*: width (percent), collapsed flag, the sizing profile,
 * a runtime-only mobile-sheet open flag, and the one-shot reveal intents that
 * outside surfaces use to ask for a panel. It deliberately owns no panel
 * selection — that is `contextWorkbenchStore.activePanelId` alone.
 * `<ArtifactWorkspaceDock />` calls `setDockSize` on every drag tick;
 * persistence is debounced internally so localStorage isn't thrashed.
 *
 * Mirrors `stores/canvas/canvas-layout-store.ts` — the artifact data lives in
 * `artifact-store.ts` (persisted v3, widely imported); this keeps the UI layout
 * concern separate so that store's careful partialize/migrate stays untouched.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { ContextPanelMode } from "@/types/context-workbench"

/**
 * The dock's *sizing* profile. Derived from whichever workbench panel is
 * active (the workspace panel needs far more room than a preview) — it is NOT
 * a router. Panel selection belongs to `contextWorkbenchStore.activePanelId`
 * alone; this used to be a second, writable `dockMode` that fought it.
 */
export type DockProfile = "compact" | "workspace"

/**
 * A one-shot request to bring a specific workbench panel forward, published by
 * surfaces that live outside the workbench (the chat header's browser button,
 * terminal file links, the Edit/Write review bridge). The mounted workbench
 * host consumes it if it owns a panel with that id, then clears it — so an
 * intent never lingers to re-route a later navigation.
 */
export interface DockRevealIntent {
  panelId: string
  mode: ContextPanelMode
}

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

/**
 * Width presets the workbench header's narrow/wide buttons map onto. The dock
 * lives inside the outer ResizablePanel and is mounted with
 * `manageOwnWidth={false}`, so the workbench cannot size itself — without this
 * mapping those two buttons render but do nothing.
 *
 * Keyed by profile: a single table made "wide" cap out at the artifact bound
 * (50%) even in workspace mode, which allows 65% — so the button silently
 * under-delivered exactly where the extra room mattered most.
 */
export const DOCK_MODE_WIDTH_PERCENT: Record<
  DockProfile,
  Record<Exclude<ContextPanelMode, "focus">, number>
> = {
  compact: { narrow: ARTIFACT_DOCK_BOUNDS.default, wide: ARTIFACT_DOCK_BOUNDS.max },
  workspace: { narrow: 45, wide: WORKSPACE_DOCK_BOUNDS.max },
}

export const ARTIFACT_DOCK_PERSIST_DEBOUNCE_MS = 150

export interface ArtifactDockLayoutState {
  /** Dock width as a percentage of the chat workspace. */
  dockSize: number
  /** When true the dock is hidden (collapsedSize 0). Default: hidden until an artifact opens. */
  dockCollapsed: boolean
  /** Persisted sizing profile, derived by the mounted workbench from its active panel. */
  dockProfile: DockProfile
  /** Runtime-only one-shot panel request published from outside the workbench. */
  revealIntent: DockRevealIntent | null
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
  /**
   * Runtime-only: bumped only when something asks for a specific width (the
   * workbench narrow/wide buttons), never by a drag. The desktop dock watches
   * this token instead of `dockSize` so applying a preset cannot fight the
   * per-tick `setDockSize` writes a drag produces.
   */
  dockSizeRequest: number

  setDockSize: (pct: number) => void
  /** Apply a width preset and ask the mounted dock to resize to it. */
  requestDockSize: (pct: number) => void
  toggleDock: () => void
  setDockCollapsed: (collapsed: boolean) => void
  /**
   * A new artifact became active. Expands the dock unless the user dismissed it
   * (then only flags it unread), so we never yank open a panel the user closed.
   */
  notifyNewArtifact: () => void
  /**
   * Record which sizing profile the active panel wants. Leaving `workspace`
   * also drops any pending workspace reveal — the user navigated away from the
   * surface that reveal was routing to.
   */
  setDockProfile: (profile: DockProfile) => void
  /** Ask the mounted workbench to bring `panelId` forward. Consumed once. */
  requestReveal: (intent: DockRevealIntent) => void
  /** Clear a consumed intent, but only if it is still the one that was published. */
  consumeRevealIntent: (panelId: string) => void
  /** Reveal the browser panel in the expanded chat right rail. */
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
  dockProfile: DockProfile
  layoutVersion: number
}

/** v2 shape, still on disk for anyone who ran a build before the convergence. */
interface LegacyPersistedArtifactDockLayoutState {
  dockSize?: number
  dockCollapsed?: boolean
  listRailOpen?: boolean
  dockMode?: "artifact" | "workspace" | "browser"
  layoutVersion?: number
}

const DEFAULTS = {
  dockSize: ARTIFACT_DOCK_BOUNDS.default,
  dockCollapsed: true,
  dockProfile: "compact" as DockProfile,
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
      revealIntent: null,
      dockSizeRequest: 0,

      requestDockSize: (pct) =>
        set((state) => ({
          dockSize: clampDockSize(pct),
          dockSizeRequest: state.dockSizeRequest + 1,
        })),

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
                dockCollapsed: false,
                userDismissed: false,
                unreadArtifact: false,
              }
        ),
      setDockProfile: (dockProfile) =>
        set((state) =>
          state.dockProfile === dockProfile
            ? state
            : dockProfile === "workspace"
              ? { dockProfile }
              : // Left the workspace surface — the reveal that routed us there
                // no longer has a target, so drop it instead of letting it
                // re-fire the next time workspace mounts.
                { dockProfile, workspaceRevealRequest: null, workspaceContext: null }
        ),
      requestReveal: (revealIntent) => set({ revealIntent, unreadArtifact: false }),
      consumeRevealIntent: (panelId) =>
        set((state) => (state.revealIntent?.panelId === panelId ? { revealIntent: null } : state)),
      openBrowser: () =>
        set({
          revealIntent: { panelId: "browser", mode: "wide" },
          dockCollapsed: false,
          userDismissed: false,
          unreadArtifact: false,
          mobileSheetOpen: true,
          workspaceRevealRequest: null,
          workspaceContext: null,
        }),
      revealWorkspaceFile: (request) =>
        set({
          revealIntent: { panelId: "workspace", mode: "wide" },
          // Seed the profile so the dock is already sized for the workspace on
          // the very first frame; the mounted workbench re-derives the same
          // value from its active panel once it settles.
          dockProfile: "workspace",
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
          revealIntent: { panelId: "workspace", mode: "wide" },
          // Seed the profile so the dock is already sized for the workspace on
          // the very first frame; the mounted workbench re-derives the same
          // value from its active panel once it settles.
          dockProfile: "workspace",
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
          dockSizeRequest: 0,
          mobileSheetOpen: false,
          userDismissed: false,
          unreadArtifact: false,
          workspaceRevealRequest: null,
          workspaceContext: null,
          revealIntent: null,
        })),
    }),
    {
      name: "cognia-artifact-dock-layout",
      version: 3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- subset persistence
      partialize: (state): any => ({
        dockSize: state.dockSize,
        dockCollapsed: state.dockCollapsed,
        dockProfile: state.dockProfile,
        layoutVersion: state.layoutVersion,
      }),
      migrate: (persisted: unknown, version) => {
        const state = (persisted ?? {}) as LegacyPersistedArtifactDockLayoutState &
          Partial<PersistedArtifactDockLayoutState>
        if (version >= 3) return state as Partial<PersistedArtifactDockLayoutState>
        // v1/v2 stored a writable three-value `dockMode` that also acted as a
        // router. Only its sizing meaning survives: `workspace` was the one
        // value that changed the dock's min/max bounds.
        const { dockMode, listRailOpen: _listRailOpen, ...rest } = state
        return {
          ...rest,
          dockProfile: dockMode === "workspace" ? "workspace" : "compact",
        } as Partial<PersistedArtifactDockLayoutState>
      },
      merge: (persisted: unknown, current: ArtifactDockLayoutState) => {
        const p = (persisted ?? {}) as Partial<PersistedArtifactDockLayoutState>
        return {
          ...current,
          ...p,
          dockSize: clampDockSize(p.dockSize ?? current.dockSize),
          dockProfile: p.dockProfile === "workspace" ? "workspace" : "compact",
          // mobileSheetOpen / userDismissed / unreadArtifact / dockSizeRequest /
          // revealIntent are runtime-only — never restore them from disk.
          dockSizeRequest: 0,
          mobileSheetOpen: false,
          userDismissed: false,
          unreadArtifact: false,
          workspaceRevealRequest: null,
          workspaceContext: null,
          revealIntent: null,
        } as ArtifactDockLayoutState
      },
    }
  )
)

export default useArtifactDockLayoutStore
