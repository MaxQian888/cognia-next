/**
 * Pure (icon-free) catalog + layout model for the mobile home (chat welcome)
 * quick-action grid and its toggleable sections.
 *
 * Mirrors `@/types/shell/sidebar` exactly: kept free of React / lucide so
 * `lib/claude/types.ts` (`AppSettings`) and the persistence layer can import
 * `MobileHomeLayout` / `DEFAULT_MOBILE_HOME_LAYOUT` without pulling the icon set
 * into their module graph. The icon mapping + resolver live in
 * `lib/shell/mobile-home-nav.ts`.
 */

/** How a quick action behaves when tapped. */
export type MobileQuickActionKind = "newChat" | "search" | "route"

/** A customizable quick action on the mobile home welcome grid. */
export interface MobileQuickActionMeta {
  /** Stable key — persisted in `MobileHomeLayout`, also the i18n key suffix. */
  id: string
  /** Tap behaviour. `route` navigates to `route`; the others fire a callback. */
  kind: MobileQuickActionKind
  /** Destination route for `kind: "route"`. */
  route?: string
  /** i18n key under `mobile.home.actions.*`. */
  i18nKey: string
}

/**
 * The full quick-action catalog, in canonical order. Actions not in
 * `MobileHomeLayout.quickActions` surface in the customizer's "available" pool,
 * so a future catalog addition is opt-in (never auto-shown on the home grid).
 */
export const MOBILE_QUICK_ACTION_CATALOG: readonly MobileQuickActionMeta[] = [
  { id: "newChat", kind: "newChat", i18nKey: "newChat" },
  { id: "search", kind: "search", i18nKey: "search" },
  { id: "workflows", kind: "route", route: "/workflows", i18nKey: "workflows" },
  { id: "discover", kind: "route", route: "/discover", i18nKey: "discover" },
  { id: "inbox", kind: "route", route: "/inbox", i18nKey: "inbox" },
  { id: "twin", kind: "route", route: "/twin", i18nKey: "twin" },
  { id: "squads", kind: "route", route: "/squads", i18nKey: "squads" },
  // `/templates` shipped a full phone body (`TemplatesMobileBody`) that nothing
  // on a phone linked to: not a quick action, not a `/me` row, not a tab-bar
  // prefix. Reachable only by typing the URL is the same as unreachable.
  { id: "templates", kind: "route", route: "/templates", i18nKey: "templates" },
  { id: "fleet", kind: "route", route: "/fleet", i18nKey: "fleet" },
  { id: "servers", kind: "route", route: "/servers", i18nKey: "servers" },
  { id: "devices", kind: "route", route: "/devices", i18nKey: "devices" },
  { id: "me", kind: "route", route: "/me", i18nKey: "me" },
] as const

/**
 * Ids that changed name after a layout was already persisted.
 *
 * The id doubles as the persistence key, so renaming one silently drops it from
 * every saved home grid: the tile does not move, it disappears. Mapped on read
 * instead, which is the same treatment `LEGACY_SIDEBAR_NAV_IDS` gives the rail.
 *
 * `agentTeams` pointed at `/agent-teams`, which ADR-0140 retired and took out
 * of navigation, so the tile was a shortcut to a route nothing else links to.
 */
export const LEGACY_MOBILE_QUICK_ACTION_IDS: Readonly<Record<string, string>> = {
  agentTeams: "squads",
}

/** Toggleable home sections (the quick-action grid + the two welcome blocks). */
export type MobileHomeSectionId = "quickActions" | "recents" | "activeRuns"

export const MOBILE_HOME_SECTION_IDS: readonly MobileHomeSectionId[] = [
  "quickActions",
  "recents",
  "activeRuns",
]

/**
 * User customization of the mobile home. `quickActions` is the ordered set of
 * action ids shown on the grid; `hiddenSections` toggles whole blocks off.
 * Anything not in `quickActions` is "available to add" (derived, not stored).
 */
export interface MobileHomeLayout {
  /** Ordered action ids shown on the home grid. */
  quickActions: string[]
  /** Section ids hidden on the home welcome. */
  hiddenSections: MobileHomeSectionId[]
}

/**
 * Default: a lean grid (new chat / search / workflows / discover), every
 * section visible (`activeRuns` further self-hides when no run is active).
 */
export const DEFAULT_MOBILE_HOME_LAYOUT: MobileHomeLayout = {
  quickActions: ["newChat", "search", "workflows", "discover"],
  hiddenSections: [],
}
