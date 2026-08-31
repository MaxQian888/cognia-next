/**
 * Discover category registry — single source of truth shared by desktop
 * sidebar and mobile chip strip. Each phase of the discover-page overhaul
 * adds new entries; the union type lists every planned id so URL-state
 * validation works the same way before and after each phase lands.
 *
 * See `C:\Users\qwdma\.claude\plans\i18n-cuddly-fairy.md` for the phasing.
 */

import { partitionByLayout, type PartitionedCatalog } from "@/lib/shell/layout-partition"
import type { SidebarLayout } from "@/types/shell/sidebar"

export const DISCOVER_GROUPS = ["agents", "extensions", "templates", "twin"] as const
export type DiscoverGroup = (typeof DISCOVER_GROUPS)[number]

/**
 * Union of every real category id. Every id here has a live data source in
 * `use-discover-query.ts` and an entry in `DISCOVER_CATEGORIES`. The two
 * cross-kind pseudo-categories (`favorites`, `foryou`) live outside this union
 * (see below) — they never enter the customizable layout.
 */
export type DiscoverCategoryId =
  | "characters"
  | "teams"
  | "skills"
  | "teamTemplates"
  | "agentPresets"
  | "plugins"
  | "mcpTools"
  | "mcpPresets"
  | "connectors"
  | "docsProviders"
  | "externalServices"
  | "integrations"
  | "ocrProviders"
  | "slashCommands"
  | "workflowTemplates"
  | "twinIngest"
  | "twinDrafts"

export interface DiscoverCategory {
  id: DiscoverCategoryId
  group: DiscoverGroup
  /**
   * lucide-react icon name. Resolved at render time via the icon module
   * (see `components/discover/discover-icon.tsx` once Phase 2 lands) so this
   * file stays a pure data module — no React imports.
   */
  iconName: string
}

/**
 * Implemented categories, ordered for both the desktop sidebar (Accordion
 * order inside each group) and the mobile chip strip (left-to-right order).
 * Phase 3 appends `mcpTools`, `connectors`, `ocrProviders`,
 * `workflowTemplates`; Phase 5 inserts `twinIngest` before `twinDrafts`.
 */
export const DISCOVER_CATEGORIES: readonly DiscoverCategory[] = [
  { id: "characters", group: "agents", iconName: "Users" },
  { id: "teams", group: "agents", iconName: "UsersRound" },
  { id: "skills", group: "agents", iconName: "Sparkles" },
  { id: "teamTemplates", group: "agents", iconName: "LayoutTemplate" },
  { id: "agentPresets", group: "agents", iconName: "Bot" },
  { id: "plugins", group: "extensions", iconName: "Puzzle" },
  { id: "mcpTools", group: "extensions", iconName: "Wrench" },
  { id: "mcpPresets", group: "extensions", iconName: "Server" },
  { id: "connectors", group: "extensions", iconName: "Plug" },
  // The three connection planes that had a catalog everywhere except the one
  // page built for browsing. Feishu/Google document sources, plugin-delivered
  // external services (Figma), and marketplace integrations (GitHub) were each
  // reachable only from their own settings pane, so "what can I connect this
  // to?" had no single answer.
  { id: "docsProviders", group: "extensions", iconName: "Cloud" },
  { id: "externalServices", group: "extensions", iconName: "Cable" },
  { id: "integrations", group: "extensions", iconName: "PlugZap" },
  { id: "ocrProviders", group: "extensions", iconName: "ScanText" },
  { id: "slashCommands", group: "extensions", iconName: "Terminal" },
  { id: "workflowTemplates", group: "templates", iconName: "Workflow" },
  { id: "twinIngest", group: "twin", iconName: "Inbox" },
  { id: "twinDrafts", group: "twin", iconName: "FileEdit" },
]

const CATEGORY_ID_SET: ReadonlySet<DiscoverCategoryId> = new Set(
  DISCOVER_CATEGORIES.map((c) => c.id)
)

/** Type guard for ?category= search-param validation. */
export function isValidCategoryId(value: unknown): value is DiscoverCategoryId {
  return typeof value === "string" && CATEGORY_ID_SET.has(value as DiscoverCategoryId)
}

export function getCategory(id: DiscoverCategoryId): DiscoverCategory | undefined {
  return DISCOVER_CATEGORIES.find((c) => c.id === id)
}

export function getCategoriesByGroup(group: DiscoverGroup): DiscoverCategory[] {
  return DISCOVER_CATEGORIES.filter((c) => c.group === group)
}

/** First implemented category — used as default when ?category= is absent or invalid. */
export const DEFAULT_DISCOVER_CATEGORY: DiscoverCategoryId = DISCOVER_CATEGORIES[0].id

// ---------------------------------------------------------------------------
// View mode — how the grid renders each category (persisted per-category on
// AppSettings.discoverViewByCategory). Mirrors the workflow library's
// grid/list toggle, with an extra denser "compact" mode.
// ---------------------------------------------------------------------------

export const DISCOVER_VIEW_MODES = ["grid", "list", "compact"] as const
export type DiscoverViewMode = (typeof DISCOVER_VIEW_MODES)[number]
export const DEFAULT_DISCOVER_VIEW: DiscoverViewMode = "grid"

export function isValidViewMode(value: unknown): value is DiscoverViewMode {
  return typeof value === "string" && (DISCOVER_VIEW_MODES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Favorites pseudo-category — a cross-kind aggregation of favorited items.
// It is NOT a real registry category: it never appears in DISCOVER_CATEGORIES,
// never enters the customizable layout (always pinned at the top, never
// hidden), and is handled specially by the query hook + route state.
// ---------------------------------------------------------------------------

export const FAVORITES_CATEGORY = "favorites" as const

// ---------------------------------------------------------------------------
// "For You" pseudo-category — the cross-kind aggregated landing (featured /
// recent / per-group rows + global search). Like `favorites` it is NOT a real
// registry category: it never appears in DISCOVER_CATEGORIES, never enters the
// customizable layout, and is pinned at the very top (above favorites). It is
// the default landing when no `?category=` is present (see resolveLandingCategory).
// ---------------------------------------------------------------------------

export const FORYOU_CATEGORY = "foryou" as const

export type DiscoverView = DiscoverCategoryId | typeof FAVORITES_CATEGORY | typeof FORYOU_CATEGORY

/** Type guard for the favorites pseudo-category. */
export function isFavoritesView(value: unknown): value is typeof FAVORITES_CATEGORY {
  return value === FAVORITES_CATEGORY
}

/** Type guard for the "For You" aggregated-landing pseudo-category. */
export function isForYouView(value: unknown): value is typeof FORYOU_CATEGORY {
  return value === FORYOU_CATEGORY
}

/** Accepts a real category id or either cross-kind pseudo-category. */
export function isValidView(value: unknown): value is DiscoverView {
  return isForYouView(value) || isFavoritesView(value) || isValidCategoryId(value)
}

// ---------------------------------------------------------------------------
// Category layout — reuses the `SidebarLayout` { pinned, hidden } shape so the
// rail and the discover page share one partition algorithm + customizer UI.
// `pinned` is the user's explicit order; everything else falls to `overflow`
// in registry order; `hidden` is removed from the sidebar / chip strip.
// ---------------------------------------------------------------------------

/** Empty layout: nothing pinned (all categories in registry order), nothing hidden. */
export const DEFAULT_DISCOVER_LAYOUT: SidebarLayout = { pinned: [], hidden: [] }

/** Partition the category registry according to a stored layout. */
export function resolveDiscoverLayout(layout: SidebarLayout): PartitionedCatalog<DiscoverCategory> {
  return partitionByLayout([...DISCOVER_CATEGORIES], layout)
}

/**
 * Default category to land on when `?category=` is absent: the first visible
 * category (pinned first, then overflow), falling back to the registry default
 * if everything is somehow hidden.
 */
export function firstVisibleCategory(layout: SidebarLayout): DiscoverCategoryId {
  const { pinned, overflow } = resolveDiscoverLayout(layout)
  return pinned[0]?.id ?? overflow[0]?.id ?? DEFAULT_DISCOVER_CATEGORY
}

/**
 * Resolve the category the page should land on when `?category=` is absent,
 * honouring the user's `discoverDefaults.landingCategory` preference:
 *
 *  - The `foryou` / `favorites` pseudo-categories are always valid landings
 *    (never hidden).
 *  - A real category id is honoured only while it is currently visible (not
 *    hidden in the layout) — a hidden preference silently falls back.
 *  - Anything else (unset / invalid / hidden) falls back to the `foryou`
 *    aggregated landing — the product default.
 */
export function resolveLandingCategory(
  preferred: DiscoverView | null | undefined,
  layout: SidebarLayout
): DiscoverView {
  if (isForYouView(preferred)) return FORYOU_CATEGORY
  if (isFavoritesView(preferred)) return FAVORITES_CATEGORY
  if (isValidCategoryId(preferred)) {
    const { pinned, overflow } = resolveDiscoverLayout(layout)
    const visible = new Set([...pinned, ...overflow].map((c) => c.id))
    if (visible.has(preferred)) return preferred
  }
  return FORYOU_CATEGORY
}
