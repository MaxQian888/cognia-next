/**
 * Icon mapping + catalog assembly + layout resolver for the two desktop window
 * bars (`components/desktop/title-bar.tsx`, `components/desktop/status-bar.tsx`).
 *
 * Mirrors `lib/shell/sidebar-nav.ts` for the nav rail: the pure catalog and the
 * `BarLayout` model live in `@/types/shell/bars`, and this module is the only
 * one that pulls in lucide, so the persistence layer stays icon-free.
 */

import {
  ActivityIcon,
  BellIcon,
  BotIcon,
  ChevronsLeftRightIcon,
  CircleDotIcon,
  CommandIcon,
  FolderIcon,
  GaugeIcon,
  GitBranchIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  TerminalIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  WifiIcon,
  ZapIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import type { Platform } from "@/hooks/use-platform"
import { resolveOrderedLayout } from "@/lib/shell/layout-partition"
import {
  barCatalogMeta,
  defaultBarLayout,
  type BarId,
  type BarItemMeta,
  type BarLayout,
  type BarZone,
} from "@/types/shell/bars"

/** id → customizer-row icon. Must cover every id in both catalogs. */
export const BAR_ITEM_ICONS: Record<string, LucideIcon> = {
  // Title bar
  appIcon: SparklesIcon,
  navArrows: ChevronsLeftRightIcon,
  workspace: FolderIcon,
  search: SearchIcon,
  commandCenter: CommandIcon,
  quickActions: ZapIcon,
  accountTop: UserRoundIcon,
  primarySidebarToggle: PanelLeftIcon,
  panelToggle: PanelBottomIcon,
  secondarySidebarToggle: PanelRightIcon,
  layoutControls: LayoutDashboardIcon,
  // Status bar
  connectivity: WifiIcon,
  executionHost: ServerIcon,
  terminal: TerminalIcon,
  branch: GitBranchIcon,
  sync: RefreshCwIcon,
  notifications: BellIcon,
  attention: TriangleAlertIcon,
  jobs: ListChecksIcon,
  agentThreads: BotIcon,
  perf: GaugeIcon,
  usage: ActivityIcon,
  accountStatus: UserRoundIcon,
  runStatus: CircleDotIcon,
}

/** A catalog entry with its resolved icon. */
export interface BarCatalogItem extends BarItemMeta {
  Icon: LucideIcon
}

/**
 * The catalog for `bar` with icons attached, filtered for the platform.
 * Outside the Tauri shell the `desktopOnly` segments are dropped so they never
 * surface in the bar or in the customizer as dead rows — the same rule
 * `getSidebarCatalog` applies to the rail.
 */
export function getBarCatalog(bar: BarId, platform: Platform): BarCatalogItem[] {
  return barCatalogMeta(bar)
    .filter((m) => !(platform !== "tauri" && m.desktopOnly))
    .map((m) => ({ ...m, Icon: BAR_ITEM_ICONS[m.id] ?? ActivityIcon }))
}

/** Rank used to normalise a stored order into zone blocks. */
const ZONE_RANK: Record<BarZone, number> = { start: 0, center: 1, end: 2 }

/** Resolved bar layout: the customizer's two lists plus the renderer's zones. */
export interface ResolvedBar {
  /** Full catalog in effective order, zone-normalised. Drives the customizer. */
  order: BarCatalogItem[]
  /** `order` minus the hidden ids — the customizer's "In the bar" list. */
  visible: BarCatalogItem[]
  /** Hidden ids in effective order — the customizer's "Hidden" list. */
  hidden: BarCatalogItem[]
  /** Visible items bucketed by zone, in order. Drives the bar renderer. */
  zones: Record<BarZone, BarCatalogItem[]>
}

/**
 * Partition `catalog` according to `layout`, then normalise the result into
 * zone blocks.
 *
 * The stored order is a single flat array, but the bar renders three fixed
 * regions. Sorting the resolved order by zone rank (a stable sort, so
 * within-zone order is the user's) means the customizer list reads in exactly
 * the sequence the bar renders — and a drag that crosses a zone boundary lands
 * the item at the edge of its own zone rather than appearing to do nothing.
 */
export function resolveBarLayout(catalog: BarCatalogItem[], layout: BarLayout): ResolvedBar {
  const base = resolveOrderedLayout(catalog, layout)
  const order = [...base.order].sort((a, b) => ZONE_RANK[a.zone] - ZONE_RANK[b.zone])

  const hiddenIds = new Set(base.hidden.map((i) => i.id))
  const visible = order.filter((i) => !hiddenIds.has(i.id))
  const hidden = order.filter((i) => hiddenIds.has(i.id))

  const zones = { start: [], center: [], end: [] } as Record<BarZone, BarCatalogItem[]>
  for (const item of visible) zones[item.zone].push(item)

  return { order, visible, hidden, zones }
}

/**
 * Splice a reordered *visible* list back into the full stored order.
 *
 * The customizer only ever drags the visible rows, but `BarLayout.order`
 * carries the hidden ids too so unhiding restores an item where the user left
 * it. Each hidden id therefore keeps the index it already holds, and the
 * reordered visible ids fill the remaining slots in sequence.
 *
 * Pure and exported so the merge is testable without simulating a dnd-kit drag
 * (jsdom has no layout, so a keyboard drag there resolves to a no-op).
 */
export function mergeVisibleOrder(
  order: readonly { id: string }[],
  hidden: readonly { id: string }[],
  nextVisibleIds: readonly string[]
): string[] {
  const hiddenIds = new Set(hidden.map((i) => i.id))
  const queue = [...nextVisibleIds]
  return order.map((item) => (hiddenIds.has(item.id) ? item.id : (queue.shift() ?? item.id)))
}

/**
 * True when `layout` matches the shipped default projected onto `catalog`.
 *
 * Off the desktop shell the desktop-only ids are absent from the catalog but
 * may linger in the stored arrays, so the comparison happens on catalog ids
 * only — otherwise "Restore defaults" would look permanently enabled there.
 */
export function isDefaultBarLayout(
  bar: BarId,
  catalog: BarCatalogItem[],
  resolved: ResolvedBar
): boolean {
  const ids = new Set(catalog.map((c) => c.id))
  const fallback = defaultBarLayout(bar)
  const expected = resolveBarLayout(catalog, {
    order: fallback.order.filter((id) => ids.has(id)),
    hidden: fallback.hidden.filter((id) => ids.has(id)),
  })
  return (
    JSON.stringify(resolved.order.map((i) => i.id)) ===
      JSON.stringify(expected.order.map((i) => i.id)) &&
    JSON.stringify(resolved.hidden.map((i) => i.id)) ===
      JSON.stringify(expected.hidden.map((i) => i.id))
  )
}

/**
 * Legacy per-segment visibility map, persisted by the UI store under
 * `cognia-ui` before the bars became orderable. Read once per install to seed
 * the new layouts so an existing user's hidden segments survive the upgrade —
 * see {@link migrateLegacyBarItems}.
 */
export type LegacyBarItems = Partial<Record<string, boolean>>

/**
 * Fold a legacy `barItems` map into a `BarLayout` for `bar`, or return `null`
 * when there is nothing to migrate.
 *
 * The legacy ids were chosen to match the new catalog ids exactly, so this is
 * an identity mapping over the subset that bar owns: every id the user turned
 * **off** becomes hidden, every id they turned **on** becomes visible even if
 * it ships hidden today (an explicit opt-in outranks a new default). Ids the
 * map never mentioned fall back to the shipped default. Order is untouched —
 * the legacy map had none.
 */
export function migrateLegacyBarItems(bar: BarId, legacy: LegacyBarItems): BarLayout | null {
  const meta = barCatalogMeta(bar)
  const mentioned = meta.filter((m) => typeof legacy[m.id] === "boolean")
  if (mentioned.length === 0) return null

  const fallback = defaultBarLayout(bar)
  const hidden = meta
    .filter((m) =>
      typeof legacy[m.id] === "boolean" ? !legacy[m.id] : fallback.hidden.includes(m.id)
    )
    .map((m) => m.id)

  return { order: fallback.order, hidden }
}
