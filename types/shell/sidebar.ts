/**
 * Pure (icon-free) catalog + layout model for the desktop left navigation rail
 * (`components/shell/guild-rail.tsx`).
 *
 * Kept free of React / lucide imports so `lib/claude/types.ts` (`AppSettings`)
 * and the persistence layer can import `SidebarLayout` / `DEFAULT_SIDEBAR_LAYOUT`
 * without pulling the icon set into their module graph. The icon mapping and the
 * resolver live in `lib/shell/sidebar-nav.ts`.
 */

/** A customizable top-level nav destination on the rail. */
export interface SidebarNavMeta {
  /** Stable key — persisted in `SidebarLayout`, also the i18n key. */
  id: string
  /** Top-level route under `app/`. */
  route: string
  /**
   * i18n key under `desktop.guildRail.*`. Equal to `id` for every current
   * item; kept as a separate field so an id can diverge from its label key.
   */
  i18nKey: string
  /** Primary feature vs. auxiliary/utility — drives the default pinned set. */
  group: "feature" | "auxiliary"
  /**
   * i18n key under `desktop.guildRail.aliases.*` holding a comma-separated list
   * of extra ⌘K search terms. Set it when a surface absorbs another one whose
   * name people still type — searching the retired name has to land somewhere.
   */
  aliasKey?: string
  /** Hidden entirely on the mobile (Capacitor) shell. */
  desktopOnly?: boolean
}

/**
 * The full customizable catalog, in canonical order. DM/Canvas (chat-guild
 * switchers), the dynamic team list, and the footer Settings button are NOT
 * here — they are fixed and rendered directly by the rail.
 */
export const SIDEBAR_NAV_META: readonly SidebarNavMeta[] = [
  // === Features (pinned by default) ===
  { id: "workflows", route: "/workflows", i18nKey: "workflows", group: "feature" },
  { id: "inbox", route: "/inbox", i18nKey: "inbox", group: "feature" },
  { id: "twin", route: "/twin", i18nKey: "twin", group: "feature" },
  { id: "discover", route: "/discover", i18nKey: "discover", group: "feature" },
  { id: "templates", route: "/templates", i18nKey: "templates", group: "feature" },
  { id: "issues", route: "/issues", i18nKey: "issues", group: "feature" },
  { id: "skills", route: "/skills", i18nKey: "skills", group: "feature" },
  { id: "plugins", route: "/plugins", i18nKey: "plugins", group: "feature" },
  { id: "agent-teams", route: "/agent-teams", i18nKey: "agentTeams", group: "feature" },
  { id: "scheduler", route: "/scheduler", i18nKey: "scheduler", group: "feature" },
  { id: "goals", route: "/goals", i18nKey: "goals", group: "feature" },
  { id: "pet", route: "/pet", i18nKey: "pet", group: "feature" },
  { id: "browser", route: "/browser", i18nKey: "browser", group: "feature", desktopOnly: true },
  // === Auxiliary (overflow → "More" by default) ===
  {
    id: "source-control",
    route: "/source-control",
    i18nKey: "sourceControl",
    group: "auxiliary",
  },
  { id: "agent-runs", route: "/agent-runs", i18nKey: "agentRuns", group: "auxiliary" },
  // The tracker's low-frequency management surfaces. `issues` is the daily
  // entry point and is pinned by default; these two live in "More" until the
  // user pins them, rather than tripling the rail for everyone.
  { id: "issue-projects", route: "/projects", i18nKey: "issueProjects", group: "auxiliary" },
  { id: "workspace", route: "/workspace", i18nKey: "workspace", group: "auxiliary" },
  // Reachable from the Go menu (`src-tauri/src/menu.rs`) long before they were
  // reachable from the navigation — the menubar could go somewhere the rail
  // could not. In "More" by default, like every other auxiliary surface.
  { id: "sites", route: "/sites", i18nKey: "sites", group: "auxiliary" },
  { id: "a2ui", route: "/a2ui", i18nKey: "a2ui", group: "auxiliary" },
  { id: "memory", route: "/memory", i18nKey: "memory", group: "auxiliary" },
  // No "observability" entry: the tracing dashboard is a sub-view of `/logs`
  // → Traces now, not a route of its own, and two rail items pointing at the
  // same page would both light up as the active destination.
  { id: "servers", route: "/servers", i18nKey: "servers", group: "auxiliary" },
  { id: "eval", route: "/eval", i18nKey: "eval", group: "auxiliary" },
  {
    id: "performance",
    route: "/performance",
    i18nKey: "performance",
    group: "auxiliary",
    desktopOnly: true,
  },
  // The tracing dashboard folded into this route's Traces channel, taking its
  // own rail entry with it — so "observability" has to resolve here in ⌘K.
  { id: "logs", route: "/logs", i18nKey: "logs", group: "auxiliary", aliasKey: "logs" },
  { id: "me", route: "/me", i18nKey: "me", group: "auxiliary" },
] as const

/**
 * User customization of the rail. `overflow` is NOT stored — it is derived as
 * `catalog − pinned − hidden` (in catalog order) by `resolveSidebarLayout`, so
 * a future catalog addition auto-lands in "More" with no layout edit.
 */
export interface SidebarLayout {
  /** Ordered ids shown directly on the rail. */
  pinned: string[]
  /** Ids hidden everywhere (not on the rail, not in "More"). */
  hidden: string[]
}

/**
 * Which window edge the rail occupies.
 *
 * Deliberately NOT a field on {@link SidebarLayout}: three of that type's
 * mutators in `components/shell/use-sidebar-layout.ts` build a fresh object
 * rather than spreading the current one, so an extra field would be dropped on
 * the next pin/hide; and `reset()` — "restore my pinned icons" — would teleport
 * the rail across the screen as a side effect. Placement is not content.
 */
export type SidebarSide = "left" | "right"

/**
 * The rail's shipped edge.
 *
 * Left — the Discord/Slack arrangement this app has always used, and the one
 * every muscle memory built against. Moving it to the right shipped briefly as
 * the default (the chat pane would own the leading edge, the navigation would
 * cluster with the context workbench) and read as disorienting rather than
 * tidy, so the right edge stays available in the customizer but is no longer
 * where the rail lands out of the box. Desktop-only — on the mobile shell the
 * rail lives inside a drawer, where "which edge" has no meaning.
 */
export const DEFAULT_SIDEBAR_SIDE: SidebarSide = "left"

/**
 * The nav rail's width in px — the `w-14` `guild-rail.tsx` draws.
 *
 * The title bar still reads the rail's *measured* width from
 * `useShellColumnsStore` rather than this number: the rail collapses to zero
 * while the expanded sidebar hosts the navigation, and the bar has to track
 * that animation frame for frame. But the rail itself now takes this as a
 * layout input — a CSS transition cannot interpolate out of the `auto` a `w-14`
 * class resolves to, so the collapsing box needs the number. The class still
 * sizes the rail's inner column, and `guild-rail.test.tsx` pins the two
 * together. Same home as `WORKBENCH_RAIL_WIDTH_PX` in
 * `@/types/shell/workbench-rail`, for the same reason.
 */
export const GUILD_RAIL_WIDTH_PX = 56

/**
 * The rail's shipped pins.
 *
 * This used to be "every `feature` item", which put eleven icons on a 64px rail
 * before counting the workspace switcher, DM, Canvas, teams, More and Settings.
 * Ten of the eleven were places you configure once and rarely revisit; these
 * three are the ones work arrives in — an inbox that fills up, workflows you
 * re-run, teams you hand tasks to. The rest are one "More" click away and any
 * of them can be pinned back from the customizer or a rail right-click.
 *
 * Order matters: it is the render order on the rail.
 */
export const DEFAULT_PINNED_IDS = ["issues", "inbox", "workflows", "agent-teams"] as const

/** Default: the four ids above pinned, everything else in "More", nothing hidden. */
export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = {
  pinned: [...DEFAULT_PINNED_IDS],
  hidden: [],
}
