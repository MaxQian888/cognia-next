import { createStore } from "zustand/vanilla"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { ContextPanelMode, ContextWorkbenchMode } from "@/types/context-workbench"

export interface ContextWorkbenchLayout {
  mode: ContextWorkbenchMode
  width: number
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
  setMode: (scopeKey: string, mode: ContextWorkbenchMode) => void
  setWidth: (scopeKey: string, width: number) => void
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
    activePanelId: null,
    userPinned: false,
    activatedPanelIds: [],
    pendingPanelIds: [],
    lastUsedAt: now,
  }
}

function normalizeLayout(
  layout: Partial<ContextWorkbenchLayout> | undefined,
  now = Date.now()
): ContextWorkbenchLayout {
  return {
    ...defaultLayout(now),
    ...layout,
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
            userPinned: activeChanged ? false : layout.userPinned,
            pendingPanelIds: layout.pendingPanelIds.filter(
              (panelId) => available.has(panelId) && panelId !== activePanelId
            ),
          }
        }),
      })),
    setMode: (scopeKey, mode) =>
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => ({ ...layout, mode })),
      })),
    setWidth: (scopeKey, width) =>
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => ({
          ...layout,
          width: Math.max(
            CONTEXT_WORKBENCH_MIN_WIDTH,
            Math.min(CONTEXT_WORKBENCH_MAX_WIDTH, width)
          ),
        })),
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
