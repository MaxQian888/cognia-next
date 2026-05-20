/**
 * Discover category registry — single source of truth shared by desktop
 * sidebar and mobile chip strip. Each phase of the discover-page overhaul
 * adds new entries; the union type lists every planned id so URL-state
 * validation works the same way before and after each phase lands.
 *
 * See `C:\Users\qwdma\.claude\plans\i18n-cuddly-fairy.md` for the phasing.
 */

export const DISCOVER_GROUPS = ["agents", "extensions", "templates", "twin"] as const
export type DiscoverGroup = (typeof DISCOVER_GROUPS)[number]

/**
 * Union of every planned category id. Some ids ("mcpTools", "connectors",
 * "ocrProviders", "workflowTemplates", "twinIngest") are reserved for later
 * phases and intentionally absent from `DISCOVER_CATEGORIES` until their
 * data source + card are wired. The union stays stable so the URL-state
 * hook does not need to grow per-phase.
 */
export type DiscoverCategoryId =
  | "characters"
  | "teams"
  | "skills"
  | "plugins"
  | "mcpTools"
  | "connectors"
  | "ocrProviders"
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
  { id: "plugins", group: "extensions", iconName: "Puzzle" },
  { id: "mcpTools", group: "extensions", iconName: "Wrench" },
  { id: "connectors", group: "extensions", iconName: "Plug" },
  { id: "ocrProviders", group: "extensions", iconName: "ScanText" },
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
