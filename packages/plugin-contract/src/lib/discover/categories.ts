/**
 * Discover category registry — single source of truth shared by desktop
 * sidebar and mobile chip strip. Each phase of the discover-page overhaul
 * adds new entries; the union type lists every planned id so URL-state
 * validation works the same way before and after each phase lands.
 *
 * See `C:\Users\qwdma\.claude\plans\i18n-cuddly-fairy.md` for the phasing.
 */

import { partitionByLayout, type PartitionedCatalog } from "../shell/layout-partition"
import type { SidebarLayout } from "../../types/shell/sidebar"

export type DiscoverViewMode = (typeof DISCOVER_VIEW_MODES)[number]

export const DISCOVER_GROUPS = ["agents", "extensions", "templates", "twin"] as const

export type DiscoverGroup = (typeof DISCOVER_GROUPS)[number]

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

export function isValidCategoryId(value: unknown): value is DiscoverCategoryId {
  return typeof value === "string" && CATEGORY_ID_SET.has(value as DiscoverCategoryId)
}

export function getCategory(id: DiscoverCategoryId): DiscoverCategory | undefined {
  return DISCOVER_CATEGORIES.find((c) => c.id === id)
}

export function getCategoriesByGroup(group: DiscoverGroup): DiscoverCategory[] {
  return DISCOVER_CATEGORIES.filter((c) => c.group === group)
}

export const DEFAULT_DISCOVER_CATEGORY: DiscoverCategoryId = DISCOVER_CATEGORIES[0].id

export const DISCOVER_VIEW_MODES = ["grid", "list", "compact"] as const

export const DEFAULT_DISCOVER_VIEW: DiscoverViewMode = "grid"

export function isValidViewMode(value: unknown): value is DiscoverViewMode {
  return typeof value === "string" && (DISCOVER_VIEW_MODES as readonly string[]).includes(value)
}

export const FAVORITES_CATEGORY = "favorites" as const

export const FORYOU_CATEGORY = "foryou" as const

export type DiscoverView = DiscoverCategoryId | typeof FAVORITES_CATEGORY | typeof FORYOU_CATEGORY

export function isFavoritesView(value: unknown): value is typeof FAVORITES_CATEGORY {
  return value === FAVORITES_CATEGORY
}

export function isForYouView(value: unknown): value is typeof FORYOU_CATEGORY {
  return value === FORYOU_CATEGORY
}

export function isValidView(value: unknown): value is DiscoverView {
  return isForYouView(value) || isFavoritesView(value) || isValidCategoryId(value)
}

export const DEFAULT_DISCOVER_LAYOUT: SidebarLayout = { pinned: [], hidden: [] }

export function resolveDiscoverLayout(layout: SidebarLayout): PartitionedCatalog<DiscoverCategory> {
  return partitionByLayout([...DISCOVER_CATEGORIES], layout)
}

export function firstVisibleCategory(layout: SidebarLayout): DiscoverCategoryId {
  const { pinned, overflow } = resolveDiscoverLayout(layout)
  return pinned[0]?.id ?? overflow[0]?.id ?? DEFAULT_DISCOVER_CATEGORY
}

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
