/**
 * Pure model for the mobile bottom tab bar customization (order / hidden /
 * launch landing). Kept icon-free so `lib/claude/types.ts` (`AppSettings`) can
 * import `MobileTabLayout` without pulling the tab-bar component (and its lucide
 * icons / "use client" boundary) into the persistence module graph.
 *
 * The canonical tab list + icons live in
 * `components/mobile/shell/mobile-tab-bar.tsx` (`MOBILE_TABS`). `TabId` is
 * re-declared here as the stable persisted key set so this module has no
 * component dependency.
 */

/** Stable bottom-tab ids — must stay in sync with `MOBILE_TABS`. */
export type MobileTabId = "chat" | "workflows" | "discover" | "me"

export const MOBILE_TAB_IDS: readonly MobileTabId[] = ["chat", "workflows", "discover", "me"]

/**
 * User customization of the bottom tab bar. `order` is the full id order;
 * `hidden` removes tabs from the bar (guarded so ≥2 stay visible);
 * `defaultLanding` is the tab the app opens to on launch (must be visible).
 */
export interface MobileTabLayout {
  order: MobileTabId[]
  hidden: MobileTabId[]
  defaultLanding: MobileTabId
}

export const DEFAULT_MOBILE_TAB_LAYOUT: MobileTabLayout = {
  order: ["chat", "workflows", "discover", "me"],
  hidden: [],
  defaultLanding: "chat",
}

/** Minimum number of tabs that must remain visible. */
export const MIN_VISIBLE_TABS = 2

/** Resolved partition of the tab catalog according to a layout. */
export interface ResolvedMobileTabs {
  /** Full id order (stored order first, then any new catalog ids appended). */
  order: MobileTabId[]
  /** Visible ids in order (hidden removed, unless that would drop below the floor). */
  visible: MobileTabId[]
  /** Hidden ids (empty when honouring them would leave too few visible). */
  hidden: MobileTabId[]
  /** Effective launch landing — guaranteed to be a visible tab. */
  defaultLanding: MobileTabId
}

/**
 * Resolve `layout` against the canonical tab list:
 *
 *  - **order**: `layout.order` (valid, deduped) then any canonical id missing
 *    from it, appended in canonical order — so a future tab surfaces with no
 *    layout edit.
 *  - **hidden**: `layout.hidden` (valid) — but if removing them would leave
 *    fewer than `MIN_VISIBLE_TABS`, the hidden set is dropped entirely (every
 *    tab stays visible) so the bar is never under-filled.
 *  - **defaultLanding**: `layout.defaultLanding` if visible, else the first
 *    visible tab.
 */
export function resolveMobileTabLayout(layout: MobileTabLayout): ResolvedMobileTabs {
  const valid = new Set<MobileTabId>(MOBILE_TAB_IDS)

  const seen = new Set<MobileTabId>()
  const order: MobileTabId[] = []
  for (const id of layout.order) {
    if (!valid.has(id) || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  for (const id of MOBILE_TAB_IDS) {
    if (!seen.has(id)) order.push(id)
  }

  const hiddenSet = new Set<MobileTabId>(layout.hidden.filter((id) => valid.has(id)))
  let visible = order.filter((id) => !hiddenSet.has(id))
  let hidden = order.filter((id) => hiddenSet.has(id))
  if (visible.length < MIN_VISIBLE_TABS) {
    visible = order
    hidden = []
  }

  const defaultLanding = visible.includes(layout.defaultLanding)
    ? layout.defaultLanding
    : visible[0]

  return { order, visible, hidden, defaultLanding }
}
