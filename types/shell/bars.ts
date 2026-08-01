/**
 * Pure (icon-free) catalog + layout model for the two desktop window bars:
 * the title bar (`components/desktop/title-bar.tsx`) and the status bar
 * (`components/desktop/status-bar.tsx`).
 *
 * Kept free of React / lucide imports so `AppSettings`
 * (`packages/agent-config-types`) and the persistence layer can import
 * `BarLayout` without pulling the icon set into their module graph — the same
 * split the nav rail uses (`@/types/shell/sidebar`). The icon mapping, the
 * platform filter and the resolver live in `@/lib/shell/bar-items`.
 *
 * ## Why `{ order, hidden }` and not the rail's `{ pinned, hidden }`
 *
 * The rail has a third home for an item — the "More" popover — so it needs
 * three buckets. A bar segment has only two states: it is in the bar or it is
 * not. Modelling it as pinned/overflow/hidden would invent an overflow menu
 * that does not exist and would nest each segment's own popover
 * (notifications, jobs, attention) inside a second one. So bars use the same
 * shape the mobile tab bar already uses (`@/types/shell/mobile-tabs`): a full
 * `order` plus a `hidden` set.
 *
 * ## Zones are structural, not user data
 *
 * Each item declares a fixed `zone`. The title bar's centre is the Tauri drag
 * region and its end holds the window controls, so "move the search pill into
 * the window-button cluster" is not a layout the shell can render. Users
 * reorder *within* a zone; `resolveBarLayout` normalises the stored order by
 * zone so a cross-zone drag lands at its own zone's edge instead of silently
 * doing nothing.
 */

/** Which of the two window bars an item belongs to. */
export type BarId = "title" | "status"

/**
 * Structural region of a bar. `center` is the flexible middle (the title bar's
 * drag region / the status bar's spacer); `start` and `end` hug the edges.
 */
export type BarZone = "start" | "center" | "end"

/**
 * Viewport floor below which an item is not rendered, mapped to a Tailwind
 * breakpoint by the renderer. This is what keeps a fully-pinned bar from
 * overflowing a narrow window — the low-priority segments drop out first
 * instead of the row clipping its trailing controls.
 */
export type BarItemMinWidth = "lg" | "xl"

/** A customizable segment of a window bar. */
export interface BarItemMeta {
  /** Stable key — persisted in `BarLayout`, also the `data-testid` suffix. */
  id: string
  /** Which bar the item lives in. */
  bar: BarId
  /** Fixed structural region. Not user-editable — see the module doc. */
  zone: BarZone
  /**
   * i18n key under `desktop.barCustomize.items.*`. Equal to `id` for every
   * current item; kept separate so an id can diverge from its label key.
   */
  i18nKey: string
  /** Dropped from the catalog outside the Tauri shell (needs a native API). */
  desktopOnly?: boolean
  /** Hidden by default on a fresh install. */
  defaultHidden?: boolean
  /** Rendered only at or above this breakpoint. */
  minWidth?: BarItemMinWidth
}

/**
 * Title-bar catalog, in canonical (default) order.
 *
 * Not here, because they are structural rather than customizable: the Tauri
 * drag regions, the Windows/Linux menubar (hiding it would delete the only
 * in-window File/Edit/View on a platform with no native menu), the window
 * min/max/close cluster, and the `toolbar.*` plugin extension slots, which are
 * owned by whichever plugin contributes to them.
 */
export const TITLE_BAR_ITEMS: readonly BarItemMeta[] = [
  { id: "appIcon", bar: "title", zone: "start", i18nKey: "appIcon" },
  { id: "navArrows", bar: "title", zone: "center", i18nKey: "navArrows" },
  { id: "workspace", bar: "title", zone: "center", i18nKey: "workspace", minWidth: "lg" },
  { id: "search", bar: "title", zone: "center", i18nKey: "search" },
  {
    id: "commandCenter",
    bar: "title",
    zone: "center",
    i18nKey: "commandCenter",
    minWidth: "lg",
  },
  {
    id: "quickActions",
    bar: "title",
    zone: "end",
    i18nKey: "quickActions",
    defaultHidden: true,
    minWidth: "xl",
  },
  { id: "accountTop", bar: "title", zone: "end", i18nKey: "accountTop", defaultHidden: true },
  {
    id: "primarySidebarToggle",
    bar: "title",
    zone: "end",
    i18nKey: "primarySidebarToggle",
  },
  { id: "panelToggle", bar: "title", zone: "end", i18nKey: "panelToggle" },
  {
    id: "secondarySidebarToggle",
    bar: "title",
    zone: "end",
    i18nKey: "secondarySidebarToggle",
  },
  { id: "layoutControls", bar: "title", zone: "end", i18nKey: "layoutControls" },
] as const

/**
 * Status-bar catalog, in canonical (default) order.
 *
 * Not here: the `statusbar.*` plugin extension slots and the centre spacer
 * that separates the two clusters.
 */
export const STATUS_BAR_ITEMS: readonly BarItemMeta[] = [
  { id: "connectivity", bar: "status", zone: "start", i18nKey: "connectivity" },
  { id: "branch", bar: "status", zone: "start", i18nKey: "branch" },
  { id: "sync", bar: "status", zone: "start", i18nKey: "sync", desktopOnly: true },
  // Workbench state, so it sits beside connectivity / branch rather than in the
  // end cluster. Desktop-only: the plain browser has no terminal transport, and
  // a permanently empty segment would just charge the bar rent.
  //
  // `defaultHidden` like `perf`: the dock already has three entry points
  // (Ctrl+`, the title bar's Terminal menu, and the dock's own toolbar), so a
  // fourth *permanent* bottom-bar control has not earned its slot against
  // `CHROME_BUDGET.statusBar`. Users who want the running-command readout can
  // pin it from the bar's customizer.
  {
    id: "terminal",
    bar: "status",
    zone: "start",
    i18nKey: "terminal",
    desktopOnly: true,
    defaultHidden: true,
  },
  { id: "notifications", bar: "status", zone: "end", i18nKey: "notifications" },
  { id: "attention", bar: "status", zone: "end", i18nKey: "attention" },
  { id: "jobs", bar: "status", zone: "end", i18nKey: "jobs" },
  {
    id: "perf",
    bar: "status",
    zone: "end",
    i18nKey: "perf",
    desktopOnly: true,
    defaultHidden: true,
  },
  { id: "usage", bar: "status", zone: "end", i18nKey: "usage", desktopOnly: true },
  { id: "accountStatus", bar: "status", zone: "end", i18nKey: "accountStatus" },
  { id: "runStatus", bar: "status", zone: "end", i18nKey: "runStatus" },
] as const

/** The catalog for a bar, before the platform filter. */
export function barCatalogMeta(bar: BarId): readonly BarItemMeta[] {
  return bar === "title" ? TITLE_BAR_ITEMS : STATUS_BAR_ITEMS
}

/**
 * User customization of one bar. `order` is the full id order (visible and
 * hidden alike, so unhiding restores an item to where it was rather than to
 * the end); `hidden` removes ids from the bar.
 */
export interface BarLayout {
  order: string[]
  hidden: string[]
}

/** Canonical order + shipped hidden set for `bar`. */
export function defaultBarLayout(bar: BarId): BarLayout {
  const meta = barCatalogMeta(bar)
  return {
    order: meta.map((m) => m.id),
    hidden: meta.filter((m) => m.defaultHidden).map((m) => m.id),
  }
}

/**
 * Shipped title-bar layout: everything in canonical order, with the account
 * button and the quick-action cluster hidden.
 *
 * The account button renders in the status bar by default — having it in both
 * bars at once was the same control twice on one screen. Quick actions (pet /
 * OCR / clipboard) are one-off launches that live in the Views menu rather
 * than in permanent 32px chrome.
 */
export const DEFAULT_TITLE_BAR_LAYOUT: BarLayout = defaultBarLayout("title")

/**
 * Shipped status-bar layout: everything in canonical order, with the
 * performance monitor hidden — mounting it starts native CPU/memory sampling,
 * so it is strictly opt-in.
 */
export const DEFAULT_STATUS_BAR_LAYOUT: BarLayout = defaultBarLayout("status")

/** Render order of the zones within a bar. */
export const BAR_ZONE_ORDER: readonly BarZone[] = ["start", "center", "end"] as const
