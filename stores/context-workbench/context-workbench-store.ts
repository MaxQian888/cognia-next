import { createStore } from "zustand/vanilla"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { ContextPanelMode, ContextWorkbenchMode } from "@/types/context-workbench"

export interface ContextWorkbenchLayout {
  mode: ContextWorkbenchMode
  /**
   * Width in px, for hosts that size the workbench themselves.
   *
   * **Intentionally dormant on the chat dock.** That host mounts with
   * `manageOwnWidth={false}` because its width belongs to the outer
   * ResizablePanel, so it renders no internal resize separator and never reads
   * this field — its width lives in `artifactDockLayoutStore.dockSize` as a
   * percentage instead. Only the canvas-document and project-file hosts drive
   * it. Kept per-scope (rather than moved out) so those hosts keep a remembered
   * width per resource; pinned by a test so it does not quietly become a second
   * writer for the dock.
   */
  width: number
  /**
   * The width the user last dragged to *while a given panel was in front*,
   * keyed by panel id. `width` above is the live one; this is the memory that
   * puts it back when the panel returns.
   *
   * Kept inside the layout (per scope) rather than in a global panel→width map
   * because `width` itself is per-scope by design — see the note above about
   * hosts keeping a remembered width per resource. A global map would quietly
   * become a second, competing writer for that same number.
   *
   * A panel with no entry here leaves `width` exactly as it was, which is the
   * pre-existing behaviour: dragging is opt-in memory, never a forced resize.
   */
  panelWidths: Record<string, number>
  activePanelId: string | null
  userPinned: boolean
  activatedPanelIds: string[]
  pendingPanelIds: string[]
  lastUsedAt: number
}

export interface ContextWorkbenchState {
  layouts: Record<string, ContextWorkbenchLayout>
  sessionOverrides: Record<string, string>
  activatePanel: (
    scopeKey: string,
    panelId: string,
    preferredMode?: ContextPanelMode,
    userPinned?: boolean,
    force?: boolean
  ) => boolean
  smartReveal: (scopeKey: string, panelId: string, preferredMode?: ContextPanelMode) => boolean
  navigatePanel: (scopeKey: string, panelId: string, preferredMode?: ContextPanelMode) => boolean
  reconcilePanels: (scopeKey: string, availablePanelIds: string[], fallbackPanelId?: string) => void
  /**
   * Record that a panel has been opened in a scope, without touching which
   * panel is showing or how wide the host is.
   *
   * Used for `scope: "session"` panels: the browser and the workspace live on
   * every artifact surface but their content belongs to the conversation, so
   * their *mounted-ness* is tracked once per session while `activePanelId`
   * stays per-resource. Routing through `navigatePanel` instead would drag the
   * session scope's active panel along and make switching artifact tabs change
   * what the session surface shows.
   */
  markPanelActivated: (scopeKey: string, panelId: string) => void
  setMode: (scopeKey: string, mode: ContextWorkbenchMode) => void
  /**
   * Set the live width. Passing `panelId` also records it as that panel's
   * remembered width, so the next reveal of that panel restores it.
   *
   * The parameter is optional rather than required so the existing callers
   * (and any host that genuinely wants a scope-wide width with no panel
   * attribution) keep their two-argument form.
   */
  setWidth: (scopeKey: string, width: number, panelId?: string) => void
  setUserPinned: (scopeKey: string, pinned: boolean) => void
  removeScope: (scopeKey: string) => void
  setSessionOverride: (resourceKey: string, sessionId: string | null) => void
}

export const CONTEXT_WORKBENCH_DEFAULT_WIDTH = 360
export const CONTEXT_WORKBENCH_MIN_WIDTH = 240
export const CONTEXT_WORKBENCH_MAX_WIDTH = 960
export const CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const CONTEXT_WORKBENCH_LAYOUT_LIMIT = 200

function defaultLayout(now = Date.now()): ContextWorkbenchLayout {
  return {
    mode: "narrow",
    width: CONTEXT_WORKBENCH_DEFAULT_WIDTH,
    panelWidths: {},
    activePanelId: null,
    userPinned: false,
    activatedPanelIds: [],
    pendingPanelIds: [],
    lastUsedAt: now,
  }
}

function clampWidth(width: number): number {
  return Math.max(CONTEXT_WORKBENCH_MIN_WIDTH, Math.min(CONTEXT_WORKBENCH_MAX_WIDTH, width))
}

/**
 * Re-clamp on every read rather than trusting what was persisted: the bounds
 * have moved before, and a stored width from the old range would otherwise be
 * restored verbatim the moment its panel came back — reintroducing the very
 * unusable dock that `onResetLayout` exists to escape. Non-numeric entries
 * (hand-edited localStorage, a partial write) are dropped outright.
 */
function normalizePanelWidths(
  panelWidths: Record<string, number> | undefined
): Record<string, number> {
  if (!panelWidths) return {}
  return Object.fromEntries(
    Object.entries(panelWidths)
      .filter(([, width]) => typeof width === "number" && Number.isFinite(width))
      .map(([panelId, width]) => [panelId, clampWidth(width)])
  )
}

function normalizeLayout(
  layout: Partial<ContextWorkbenchLayout> | undefined,
  now = Date.now()
): ContextWorkbenchLayout {
  return {
    ...defaultLayout(now),
    ...layout,
    panelWidths: normalizePanelWidths(layout?.panelWidths),
    activatedPanelIds: [...new Set(layout?.activatedPanelIds ?? [])],
    pendingPanelIds: [...new Set(layout?.pendingPanelIds ?? [])],
    lastUsedAt: layout?.lastUsedAt ?? now,
  }
}

export function pruneContextWorkbenchLayouts(
  layouts: Record<string, ContextWorkbenchLayout>,
  now = Date.now()
): Record<string, ContextWorkbenchLayout> {
  return Object.fromEntries(
    Object.entries(layouts)
      .map(([scopeKey, layout]) => [scopeKey, normalizeLayout(layout, now)] as const)
      .filter(([, layout]) => now - layout.lastUsedAt <= CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS)
      .sort(([leftKey, left], [rightKey, right]) => {
        const recency = right.lastUsedAt - left.lastUsedAt
        return recency === 0 ? leftKey.localeCompare(rightKey) : recency
      })
      .slice(0, CONTEXT_WORKBENCH_LAYOUT_LIMIT)
  )
}

/**
 * Focus is a takeover, not a resting layout — the same contract a Dialog has.
 * Persisting it meant a reload came back with the workbench covering the whole
 * window (and, if the user had collapsed the dock on the way out, covering it
 * with a surface they had already dismissed). Applied only at the persistence
 * boundary; the live store keeps focus for as long as the user holds it.
 */
function withoutTakeoverModes(
  layouts: Record<string, ContextWorkbenchLayout>
): Record<string, ContextWorkbenchLayout> {
  return Object.fromEntries(
    Object.entries(layouts).map(([scopeKey, layout]) => [
      scopeKey,
      layout.mode === "focus" ? { ...layout, mode: "narrow" as const } : layout,
    ])
  )
}

function updateLayout(
  layouts: Record<string, ContextWorkbenchLayout>,
  scopeKey: string,
  update: (layout: ContextWorkbenchLayout) => ContextWorkbenchLayout
): Record<string, ContextWorkbenchLayout> {
  const now = Date.now()
  const current = normalizeLayout(layouts[scopeKey] ?? defaultLayout(now), now)
  return pruneContextWorkbenchLayouts(
    { ...layouts, [scopeKey]: { ...update(current), lastUsedAt: now } },
    now
  )
}

function stateCreator(
  set: (update: (state: ContextWorkbenchState) => Partial<ContextWorkbenchState>) => void,
  get: () => ContextWorkbenchState
): ContextWorkbenchState {
  const reveal = (
    scopeKey: string,
    panelId: string,
    preferredMode: ContextPanelMode = "narrow",
    userPinned = false,
    force = false
  ) => {
    const current = get().layouts[scopeKey]
    if (!force && current?.userPinned && !userPinned) {
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => ({
          ...layout,
          pendingPanelIds: layout.pendingPanelIds.includes(panelId)
            ? layout.pendingPanelIds
            : [...layout.pendingPanelIds, panelId],
        })),
      }))
      return false
    }
    set((state) => ({
      layouts: updateLayout(state.layouts, scopeKey, (layout) => ({
        ...layout,
        mode: preferredMode,
        // Restoring the width here — rather than in the renderer — is what makes
        // every route free: the rail, the group tabs, the overflow menu and
        // `ctx.contextPanels.reveal()` all funnel through this one `reveal`.
        // `preferredMode` still decides narrow-vs-wide; this only decides how
        // many pixels "narrow" means for *this* panel, which is a question
        // `preferredMode` was never able to answer.
        width: layout.panelWidths[panelId] ?? layout.width,
        activePanelId: panelId,
        userPinned: userPinned ? true : layout.userPinned,
        pendingPanelIds: layout.pendingPanelIds.filter((id) => id !== panelId),
        activatedPanelIds: layout.activatedPanelIds.includes(panelId)
          ? layout.activatedPanelIds
          : [...layout.activatedPanelIds, panelId],
      })),
    }))
    return true
  }

  return {
    layouts: {},
    sessionOverrides: {},
    activatePanel: reveal,
    smartReveal: (scopeKey, panelId, preferredMode) =>
      reveal(scopeKey, panelId, preferredMode, false, false),
    navigatePanel: (scopeKey, panelId, preferredMode = "narrow") =>
      reveal(scopeKey, panelId, preferredMode, false, true),
    reconcilePanels: (scopeKey, availablePanelIds, fallbackPanelId) =>
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => {
          const available = new Set(availablePanelIds)
          const activePanelId =
            layout.activePanelId && available.has(layout.activePanelId)
              ? layout.activePanelId
              : fallbackPanelId && available.has(fallbackPanelId)
                ? fallbackPanelId
                : (availablePanelIds[0] ?? null)
          const activeChanged = activePanelId !== layout.activePanelId
          return {
            ...layout,
            activePanelId,
            // The other route by which a different panel ends up in front: the
            // one that was showing is gone (plugin disabled, capability lost)
            // and the fallback takes over. Gated on `activeChanged` so the
            // reconcile that runs on every mount stays a no-op for the width.
            width:
              activeChanged && activePanelId
                ? (layout.panelWidths[activePanelId] ?? layout.width)
                : layout.width,
            userPinned: activeChanged ? false : layout.userPinned,
            // Deliberately does NOT touch `activatedPanelIds`. That list also
            // decides whether a panel's next activation is a `first` or a
            // `restore`, so seeding it here would rob a fresh scope's default
            // panel of its `onFirstActivate`. Mounting the active panel is the
            // renderer's job instead — see the mount gate in ContextWorkbench.
            pendingPanelIds: layout.pendingPanelIds.filter(
              (panelId) => available.has(panelId) && panelId !== activePanelId
            ),
          }
        }),
      })),
    markPanelActivated: (scopeKey, panelId) =>
      set((state) =>
        state.layouts[scopeKey]?.activatedPanelIds.includes(panelId)
          ? state
          : {
              layouts: updateLayout(state.layouts, scopeKey, (layout) => ({
                ...layout,
                activatedPanelIds: layout.activatedPanelIds.includes(panelId)
                  ? layout.activatedPanelIds
                  : [...layout.activatedPanelIds, panelId],
              })),
            }
      ),
    setMode: (scopeKey, mode) =>
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => ({ ...layout, mode })),
      })),
    setWidth: (scopeKey, width, panelId) =>
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => {
          const clamped = clampWidth(width)
          return {
            ...layout,
            width: clamped,
            // The clamped value, not the raw one: what gets restored later has
            // to be a width the workbench can actually sit at, or the memory
            // would replay an out-of-bounds drag every time the panel returns.
            panelWidths: panelId
              ? { ...layout.panelWidths, [panelId]: clamped }
              : layout.panelWidths,
          }
        }),
      })),
    setUserPinned: (scopeKey, userPinned) =>
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => ({ ...layout, userPinned })),
      })),
    removeScope: (scopeKey) =>
      set((state) => {
        const layouts = { ...state.layouts }
        delete layouts[scopeKey]
        return { layouts }
      }),
    setSessionOverride: (resourceKey, sessionId) =>
      set((state) => {
        const sessionOverrides = { ...state.sessionOverrides }
        if (sessionId) sessionOverrides[resourceKey] = sessionId
        else delete sessionOverrides[resourceKey]
        return { sessionOverrides }
      }),
  }
}

/** Test-only isolated store; production uses the persisted bound store below. */
export function createContextWorkbenchStoreForTesting() {
  return createStore<ContextWorkbenchState>()(stateCreator)
}

export const useContextWorkbenchStore = create<ContextWorkbenchState>()(
  persist(stateCreator, {
    name: "cognia-context-workbench-v1",
    storage: persistLocalStorage(),
    version: 2,
    migrate: (persisted) => {
      const persistedState = persisted as Partial<ContextWorkbenchState> | undefined
      const now = Date.now()
      const layouts = Object.fromEntries(
        Object.entries(persistedState?.layouts ?? {}).map(([scopeKey, layout]) => [
          scopeKey,
          normalizeLayout(layout, now),
        ])
      )
      return {
        layouts: withoutTakeoverModes(pruneContextWorkbenchLayouts(layouts, now)),
        sessionOverrides: persistedState?.sessionOverrides ?? {},
      }
    },
    partialize: (state) => ({
      layouts: withoutTakeoverModes(pruneContextWorkbenchLayouts(state.layouts)),
      sessionOverrides: state.sessionOverrides,
    }),
    merge: (persisted, current) => {
      const persistedState = persisted as Partial<ContextWorkbenchState>
      return {
        ...current,
        ...persistedState,
        layouts: withoutTakeoverModes(pruneContextWorkbenchLayouts(persistedState.layouts ?? {})),
        sessionOverrides: persistedState.sessionOverrides ?? {},
      }
    },
  })
)
