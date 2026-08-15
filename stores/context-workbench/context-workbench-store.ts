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
  /**
   * When non-null, the workbench shows two panels stacked vertically. The
   * primary panel is `activePanelId`; the secondary is this one.
   *
   * Three degenerate shapes are impossible by construction, because
   * {@link normalizeLayout} drops them on every read rather than trusting what
   * was persisted: equal to `activePanelId` (a panel split against itself),
   * present while `mode === "narrow"` (no room for two panes), and a
   * non-string. `reconcilePanels` additionally drops one naming a panel that no
   * longer resolves — a plugin being disabled must not leave half the body
   * pointing at nothing.
   *
   * The renderer applies two further *projections* without writing back here:
   * the mobile drawer and any body narrower than
   * {@link CONTEXT_WORKBENCH_SPLIT_MIN_WIDTH} show a single pane while leaving
   * this field intact, so a phone — or a drag past the threshold and back —
   * cannot destroy the desktop layout.
   */
  splitPanelId: string | null
  /**
   * Percentage of height the primary pane occupies, clamped to
   * {@link CONTEXT_WORKBENCH_SPLIT_MIN_RATIO}–{@link CONTEXT_WORKBENCH_SPLIT_MAX_RATIO}.
   *
   * Kept even while `splitPanelId` is null — it is a remembered preference,
   * exactly like `panelWidths`, so re-opening a split lands where the user last
   * left it.
   */
  splitRatio: number
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
  /**
   * Open a second panel below the active one (vertical split).
   *
   * Fail-closed and boolean-returning, like `activatePanel`: refuses when there
   * is no primary to split from, when `panelId` is the panel already in front,
   * and when the mode has no room for two panes. The renderer gates the menu on
   * the same predicate ({@link isSplitEligibleMode}) so the store and the UI can
   * never disagree about what is offerable.
   */
  activateSplit: (scopeKey: string, panelId: string) => boolean
  /** Close the split panel, returning to single-panel view. Keeps the ratio. */
  closeSplit: (scopeKey: string) => void
  /** Update the split ratio (percentage of height for the primary). */
  setSplitRatio: (scopeKey: string, ratio: number) => void
  removeScope: (scopeKey: string) => void
  setSessionOverride: (resourceKey: string, sessionId: string | null) => void
}

export const CONTEXT_WORKBENCH_DEFAULT_WIDTH = 360
export const CONTEXT_WORKBENCH_MIN_WIDTH = 240
export const CONTEXT_WORKBENCH_MAX_WIDTH = 960
export const CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const CONTEXT_WORKBENCH_LAYOUT_LIMIT = 200
export const CONTEXT_WORKBENCH_SPLIT_MIN_RATIO = 20
export const CONTEXT_WORKBENCH_SPLIT_MAX_RATIO = 80
export const CONTEXT_WORKBENCH_SPLIT_DEFAULT_RATIO = 50
/**
 * Narrower than this and the two panes are shorter than their own headers.
 *
 * A measured width rather than a mode, because `mode` cannot answer it: a host
 * mounting with `manageOwnWidth={false}` owns its own pixels, so `mode` there
 * states an intent the container may not actually have room for.
 */
export const CONTEXT_WORKBENCH_SPLIT_MIN_WIDTH = 480

/**
 * Modes with room for two stacked panes.
 *
 * `collapsed` is deliberately absent but is *not* the same as ineligible: it is
 * a visibility state, so a split survives it and comes back on expand. Only
 * `narrow` destroys one.
 */
export function isSplitEligibleMode(mode: ContextWorkbenchMode): boolean {
  return mode === "wide" || mode === "focus"
}

function normalizeSplitRatio(ratio: unknown): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
    return CONTEXT_WORKBENCH_SPLIT_DEFAULT_RATIO
  }
  return Math.max(
    CONTEXT_WORKBENCH_SPLIT_MIN_RATIO,
    Math.min(CONTEXT_WORKBENCH_SPLIT_MAX_RATIO, ratio)
  )
}

/**
 * The panels the user can see: one normally, two while split.
 *
 * Exported because three readers have to agree on it or the workbench starts
 * lying — the renderer's `active` prop (which drives `inert`, `aria-hidden` and
 * `<Activity>`), the lifecycle diff that decides whether `onFirstActivate`
 * fires, and `isPluginContextPanelVisible`. Note that a *host* may narrow this
 * further (mobile, sub-480px); this is the layout's answer, not the screen's.
 */
export function visibleContextPanelIds(layout: ContextWorkbenchLayout): string[] {
  if (!layout.activePanelId) return []
  return layout.splitPanelId && layout.splitPanelId !== layout.activePanelId
    ? [layout.activePanelId, layout.splitPanelId]
    : [layout.activePanelId]
}

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
    splitPanelId: null,
    splitRatio: CONTEXT_WORKBENCH_SPLIT_DEFAULT_RATIO,
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
  const mode = layout?.mode ?? "narrow"
  const activePanelId = layout?.activePanelId ?? null
  return {
    ...defaultLayout(now),
    ...layout,
    panelWidths: normalizePanelWidths(layout?.panelWidths),
    activatedPanelIds: [...new Set(layout?.activatedPanelIds ?? [])],
    pendingPanelIds: [...new Set(layout?.pendingPanelIds ?? [])],
    lastUsedAt: layout?.lastUsedAt ?? now,
    // The single choke point for the split invariants, for the same reason
    // `normalizePanelWidths` above is one for widths: every read path —
    // `pruneContextWorkbenchLayouts`, `updateLayout`, `migrate`, `partialize`,
    // `merge` — funnels through here, so none of them can reintroduce a shape
    // the renderer would have to defend against a second time.
    //
    // It also closes the `withoutTakeoverModes` seam: a persisted focus+split
    // is downgraded to narrow at the persistence boundary, and narrow has no
    // room for a second pane, so the next normalize drops the split with it.
    splitPanelId:
      typeof layout?.splitPanelId === "string" &&
      layout.splitPanelId.length > 0 &&
      layout.splitPanelId !== activePanelId &&
      mode !== "narrow"
        ? layout.splitPanelId
        : null,
    splitRatio: normalizeSplitRatio(layout?.splitRatio),
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
 *
 * The downgrade drops any open split along with it. That cannot be left to
 * `normalizeLayout` even though it enforces the same rule: this runs *after*
 * the normalize inside `pruneContextWorkbenchLayouts`, so a focus+split layout
 * would be normalized while still legal and only then rewritten into an
 * illegal narrow+split. The function that creates the violation owns it.
 */
function withoutTakeoverModes(
  layouts: Record<string, ContextWorkbenchLayout>
): Record<string, ContextWorkbenchLayout> {
  return Object.fromEntries(
    Object.entries(layouts).map(([scopeKey, layout]) => [
      scopeKey,
      layout.mode === "focus" ? { ...layout, mode: "narrow" as const, splitPanelId: null } : layout,
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
      layouts: updateLayout(state.layouts, scopeKey, (layout) => {
        // Navigating to the panel already in the *second* pane swaps the two
        // rather than replacing the first. This has to live here rather than in
        // a caller for the same reason the width restore below does — the rail,
        // the group tabs, the overflow menu and `ctx.contextPanels.reveal()`
        // all funnel through this one `reveal`, so putting it here is what
        // makes every route free.
        //
        // It is also required for correctness, not just for the gesture:
        // without it the same id would land in `activePanelId` and
        // `splitPanelId` at once, and `normalizeLayout` would then silently
        // drop the split as degenerate.
        const swapping = layout.splitPanelId === panelId
        // Nearly every panel reaches `reveal` with `preferredMode` defaulted to
        // "narrow" (see `handleActivate`), so honouring that while a split is
        // open would close it on the very next rail click — the swap above
        // could never be observed. `preferredMode` is a preference, not an
        // instruction; an explicit `setMode("narrow")` still closes the split.
        const keepSplitMode = layout.splitPanelId !== null && preferredMode === "narrow"
        return {
          ...layout,
          mode: keepSplitMode ? layout.mode : preferredMode,
          // Restoring the width here — rather than in the renderer — is what
          // makes every route free. `preferredMode` still decides
          // narrow-vs-wide; this only decides how many pixels "narrow" means
          // for *this* panel, which is a question `preferredMode` was never
          // able to answer.
          width: layout.panelWidths[panelId] ?? layout.width,
          activePanelId: panelId,
          splitPanelId: swapping ? layout.activePanelId : layout.splitPanelId,
          // Mirrored so each panel keeps the height it already had; swapping
          // panes should move the content, not resize it.
          splitRatio: swapping ? normalizeSplitRatio(100 - layout.splitRatio) : layout.splitRatio,
          userPinned: userPinned ? true : layout.userPinned,
          pendingPanelIds: layout.pendingPanelIds.filter((id) => id !== panelId),
          activatedPanelIds: layout.activatedPanelIds.includes(panelId)
            ? layout.activatedPanelIds
            : [...layout.activatedPanelIds, panelId],
        }
      }),
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
            // Computed against the *new* `activePanelId`, not the old one, so
            // the fallback promotion above cannot leave the same panel in both
            // panes. Covers the three ways a split goes stale: its panel stopped
            // resolving (plugin disabled, capability or permission lost), it was
            // never available to begin with, and the promotion just collided
            // with it.
            splitPanelId:
              layout.splitPanelId &&
              available.has(layout.splitPanelId) &&
              layout.splitPanelId !== activePanelId
                ? layout.splitPanelId
                : null,
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
        layouts: updateLayout(state.layouts, scopeKey, (layout) => ({
          ...layout,
          mode,
          // Narrow has no room for two stacked panes, so it closes the split.
          //
          // `collapsed` deliberately does NOT: it is a visibility state, not a
          // layout one. `bodyHidden` in the renderer merges this mode with the
          // host-driven `railOnly` precisely so the two collapse routes cannot
          // disagree — and `railOnly` hosts never write mode at all, so closing
          // here would make one route destructive and the other not.
          splitPanelId: mode === "narrow" ? null : layout.splitPanelId,
        })),
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
    activateSplit: (scopeKey, panelId) => {
      const layout = get().layouts[scopeKey]
      // Fail closed on every shape `normalizeLayout` would only have to discard
      // again, and on the one the renderer gates its menu with. Returning false
      // rather than silently no-op'ing lets the caller skip the lifecycle work
      // it would otherwise do for a split that never opened.
      if (!panelId) return false
      if (!layout?.activePanelId) return false
      if (panelId === layout.activePanelId) return false
      if (!isSplitEligibleMode(layout.mode)) return false
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (current) => ({
          ...current,
          splitPanelId: panelId,
          // `|| 50` was wrong in both directions: it rewrote a legitimate 0 and
          // let a hand-written 150 through. Normalizing handles both.
          splitRatio: normalizeSplitRatio(current.splitRatio),
          // Load-bearing. The renderer's mount gate is
          // `if (!visible && !activatedIn.includes(panel.id)) return null`, so a
          // panel that has never been opened would be dropped into the second
          // pane and render nothing at all.
          activatedPanelIds: current.activatedPanelIds.includes(panelId)
            ? current.activatedPanelIds
            : [...current.activatedPanelIds, panelId],
        })),
      }))
      return true
    },
    closeSplit: (scopeKey) =>
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => ({
          ...layout,
          splitPanelId: null,
        })),
      })),
    setSplitRatio: (scopeKey, ratio) =>
      set((state) => ({
        layouts: updateLayout(state.layouts, scopeKey, (layout) => ({
          ...layout,
          // Not an inline clamp: `Math.max(20, Math.min(80, NaN))` is NaN, and a
          // NaN ratio reaches the renderer as an unparseable grid track.
          splitRatio: normalizeSplitRatio(ratio),
        })),
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
    version: 3,
    migrate: (persisted, version) => {
      const persistedState = persisted as Partial<ContextWorkbenchState> | undefined
      const now = Date.now()
      const layouts = Object.fromEntries(
        Object.entries(persistedState?.layouts ?? {}).map(([scopeKey, layout]) => [
          scopeKey,
          normalizeLayout(
            // Before v3 `splitPanelId` was persisted but dormant — no renderer
            // ever read it, so anything stored there is a leftover default or a
            // hand-written value, never a layout a user chose. Restoring it now
            // would paint a second pane nobody asked for on the first load after
            // upgrade. Only the migration clears it: `partialize` and `merge`
            // must not, or a live split would not survive a reload.
            version < 3 ? { ...layout, splitPanelId: null } : layout,
            now
          ),
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
